/** PR #62's connect/manual-model/offline-pin workflow, with host request,
 * credential-binding and optimistic-write boundaries. No secret reaches GET. */
import { createHmac, randomBytes } from "node:crypto";
import { normalizeBaseUrl, parseModelIds, sanitizeCustomModelOverrides, type CustomProviderSettings } from "../core/settings.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { readCustomAuth } from "../store/auth.ts";
import { customAuthState, customKeyAuthorized, persistCustomAuth } from "./custom-provider-auth.ts";
import type { CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { discoverModels, mergeManualModels, syncCustomProvider } from "./custom-provider.ts";
import { parseCustomModelOverridesBody } from "./settings-body.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

const revisionKey = Symbol.for("learnharness.custom-provider-revision");
const globals = globalThis as typeof globalThis & { [revisionKey]?: Buffer };
const secret = globals[revisionKey] ??= randomBytes(32);
const failure = (error: string, status = 400) => Response.json({ error }, { status });
const stale = () => failure("Custom configuration or credentials changed. Reload configuration and retry.", 409);

function snapshot(inspectKey = false) {
	const record = readSettings() ?? { version: 1 };
	const cp = record.customProvider;
	// Keyless never looks up a key for authentication or revision generation.
	// An explicit API-key inspection is used only after the user selects that mode.
	const auth = customAuthState(inspectKey);
	const key = auth.key;
	// Public revisions contain configuration only, never credential material.
	// Effective credentials are compared privately across the awaited probe.
	const etag = `"${createHmac("sha256", secret).update(JSON.stringify([cp ?? null, auth.binding ?? null, auth.readable])).digest("base64url")}"`;
	return { record, cp, auth, key, etag };
}

function response(body: object) {
	return Response.json(body, { headers: { etag: snapshot().etag, "cache-control": "no-store" } });
}

export function customProviderGet(request: Request): Response {
	const inspect = new URL(request.url).searchParams.get("authMode") === "apiKey";
	const current = snapshot();
	const s = snapshot(inspect || current.cp?.authMode === "apiKey");
	return response({
		baseUrl: s.cp?.baseUrl ?? "", authMode: s.cp?.authMode ?? "keyless",
		models: s.cp?.models ?? [], overrides: s.cp?.overrides ?? {}, manualModels: s.cp?.manualModels ?? [],
		keyPresent: Boolean(s.key), keySource: s.auth.source,
		keyReuseRequired: Boolean(s.key) && !customKeyAuthorized(s.cp, s.auth),
	});
}

function authorized(request: Request): boolean {
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	if (desktop) return desktopAPIAuthorized(request.headers);
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	try {
		// Next's standalone Request URL can use its internal hostname. Match
		// the actual addressed Host through the app's existing origin seam;
		// never trust forwarded-origin headers.
		return origin === subscriptionRequestOrigin(request)
			&& (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	} catch { return false; }
}

/** Auth pair FIRST, matching config nonce SECOND. Any interrupted/failed
 * cross-file publication is durably unusable, including with a real env key.
 * Best-effort rollback restores the entire old pair, never just its secret. */
function commit(cp: CustomProviderSettings | undefined, binding?: CustomAuthBinding, fileKey?: string): void {
	const latest = readSettings() ?? { version: 1 };
	const oldAuth = binding ? readCustomAuth() : undefined;
	let published = false;
	try {
		if (binding) { persistCustomAuth(binding, fileKey); published = true; }
		const { customProvider: _old, ...rest } = latest;
		writeSettings(cp ? { ...rest, customProvider: cp } : rest);
	} catch {
		if (published && oldAuth) {
			try { persistCustomAuth(oldAuth.binding, oldAuth.fileKey()); } catch { /* durable nonce mismatch fails closed after restart */ }
		}
		throw new Error("Unable to save custom configuration. Reload configuration and retry.");
	}
	syncCustomProvider();
}

export async function customProviderMutation(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Custom configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("JSON content-type is required.", 415);
	try {
		// Next can represent an empty DELETE as a zero-byte stream rather
		// than null. Bound it either way; only DELETE permits an empty body.
		const body = await readBoundedJson(request, 64 * 1024, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body");
		const raw = body as Record<string, unknown>;
		const before = snapshot(raw.authMode === "apiKey");
		if (!before.auth.readable) return failure("Custom authorization storage is unavailable. No changes were saved.", 500);
		if (request.headers.get("if-match") !== before.etag) return stale();
		if (request.method === "DELETE") {
			commit(undefined, { version: 1, id: randomBytes(16).toString("hex"), authMode: "disabled" });
			return response({ ok: true });
		}
		if (request.method === "PATCH") {
			const parsed = parseCustomModelOverridesBody(raw);
			if (!parsed.ok) return failure(parsed.error);
			if (!before.cp?.baseUrl) return failure("No custom endpoint configured", 409);
			const overrides = sanitizeCustomModelOverrides(parsed.settings, before.cp.models?.map((m) => m.id));
			commit({ ...before.cp, overrides });
			return response({ ok: true, overrides });
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		const base = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
		if (!base) return failure("Base URL must be http(s), with no credentials, query or fragment.");
		if (raw.authMode !== "keyless" && raw.authMode !== "apiKey") return failure("Choose Keyless or API key authentication.");
		const authMode = raw.authMode;
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("API key must be a string.");
		const supplied = typeof raw.key === "string" ? raw.key.trim() : undefined;
		if (authMode === "apiKey" && supplied === "") return failure("Choose Keyless to clear authentication.");
		const envOwned = before.auth.source === "env";
		if (envOwned && supplied) return failure("Environment owns the effective key. Change the environment or explicitly reuse that key.");
		// A shadowed file key is not the key that will run. Require consent for
		// the actual environment key when authorizing a different endpoint.
		const hasNewEffectiveKey = Boolean(supplied) && !envOwned;
		const changedTarget = before.cp?.baseUrl !== base;
		if (authMode === "apiKey" && (changedTarget || !customKeyAuthorized(before.cp, before.auth)) && !hasNewEffectiveKey && raw.reuseKey !== true) {
			return failure("Enter a new key or explicitly allow reuse of the effective existing key for this URL.");
		}
		const effectiveKey = authMode === "apiKey" ? (envOwned ? before.key : supplied || before.key) : undefined;
		if (authMode === "apiKey" && !effectiveKey) return failure("API key mode requires an effective key.");
		const manualModels = parseModelIds(raw.manualModels);
		if (manualModels.length > 10_000) return failure("Model list exceeds 10000 entries");
		const found = await discoverModels(base, effectiveKey);
		if (!found.ok && (found.fatal || found.status === 401 || found.status === 403)) return failure(found.error, 502);
		if (!found.ok && !manualModels.length) return failure(`${found.error}. If this endpoint has no /models list, add model IDs manually.`, 502);
		// Discovery yields; both the custom record and the credential must still
		// match. Unrelated settings edits are preserved by commit's fresh merge.
		const now = snapshot(authMode === "apiKey");
		if (before.etag !== now.etag || JSON.stringify(before.auth) !== JSON.stringify(now.auth)) return stale();
		const discovered = found.ok ? found.models : !changedTarget ? before.cp?.models ?? [] : [];
		const models = mergeManualModels(discovered, manualModels);
		if (models.length > 10_000) return failure("Model list exceeds 10000 entries");
		const overrides = sanitizeCustomModelOverrides(!changedTarget ? before.cp?.overrides : undefined, models.map((m) => m.id));
		const id = randomBytes(16).toString("hex");
		const fileKey = authMode === "keyless" ? undefined : supplied && !envOwned ? supplied : now.auth.fileKey;
		const fileKeyBaseUrl = authMode === "apiKey" ? envOwned ? now.auth.binding?.fileKeyBaseUrl : base : undefined;
		const binding: CustomAuthBinding = { version: 1, id, baseUrl: base, authMode, ...(fileKey && fileKeyBaseUrl ? { fileKeyBaseUrl } : {}) };
		commit({ baseUrl: base, authMode, credentialBindingId: id, models, overrides, ...(manualModels.length ? { manualModels } : {}) }, binding, fileKey);
		return response({ ok: true, models });
	} catch (error) {
		return failure(error instanceof CustomBodyLimitError ? "Configuration body exceeds 64 KiB." : error instanceof SyntaxError ? "Invalid JSON body." : "Unable to save custom configuration. Reload configuration and retry.", error instanceof CustomBodyLimitError ? 413 : error instanceof SyntaxError ? 400 : 500);
	}
}

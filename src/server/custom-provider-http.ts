/** PR #62's connect/manual-model/offline-pin workflow, with host request,
 *  credential-binding and optimistic-write boundaries — now per endpoint. No
 *  secret reaches GET, and one endpoint's credentials never authorize another's
 *  URL. */
import { createHmac, randomBytes } from "node:crypto";
import {
	CUSTOM_PROVIDER_LIMIT,
	customProviderName,
	isCustomProviderId,
	normalizeBaseUrl,
	parseModelIds,
	sanitizeCustomModelOverrides,
	type CustomProviderSettings,
} from "../core/settings.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { customAuthState, customKeyAuthorized, persistCustomAuth, type CustomAuthState } from "./custom-provider-auth.ts";
import { readCustomAuth } from "../store/auth.ts";
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

/** One endpoint's stored row plus what its authorization currently resolves
 *  to. `auth.key` is present only when the caller asked to inspect it. */
interface EndpointSnapshot {
	cp: CustomProviderSettings;
	auth: CustomAuthState;
}

function storedEndpoints(): CustomProviderSettings[] {
	return readSettings()?.customProviders ?? [];
}

/** Every endpoint, read in ONE pass so the revision and the payload agree. */
function snapshot(inspectKey = false): { endpoints: EndpointSnapshot[]; etag: string } {
	const endpoints = storedEndpoints().map((cp) => ({
		cp,
		// A stored API-key endpoint is inspected for its own status row; keyless
		// reads only the nonsecret marker, never a file/env key.
		auth: customAuthState(cp.id, inspectKey || cp.authMode === "apiKey"),
	}));
	// Public revisions contain configuration only, never credential material.
	// Effective credentials are compared privately across the awaited probe.
	const etag = `"${createHmac("sha256", secret)
		.update(JSON.stringify([endpoints.map((e) => e.cp), endpoints.map((e) => e.auth.binding ?? null), endpoints.map((e) => e.auth.readable)]))
		.digest("base64url")}"`;
	return { endpoints, etag };
}

function response(body: object, etag: string) {
	return Response.json(body, { headers: { etag, "cache-control": "no-store" } });
}

function publicEndpoint({ cp, auth }: EndpointSnapshot) {
	return {
		id: cp.id,
		name: customProviderName(cp),
		baseUrl: cp.baseUrl ?? "",
		authMode: cp.authMode ?? "keyless",
		models: cp.models ?? [],
		overrides: cp.overrides ?? {},
		manualModels: cp.manualModels ?? [],
		keyPresent: Boolean(auth.key),
		keySource: auth.source,
		keyReuseRequired: Boolean(auth.key) && !customKeyAuthorized(cp, auth),
	};
}

export function customProviderGet(request: Request): Response {
	const params = new URL(request.url).searchParams;
	const inspect = params.get("authMode") === "apiKey";
	const { endpoints, etag } = snapshot(inspect);
	return response({ endpoints: endpoints.map(publicEndpoint), revision: etag, limit: CUSTOM_PROVIDER_LIMIT }, etag);
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
 *  cross-file publication is durably unusable, including with a real env key.
 *  Best-effort rollback restores the endpoint's whole old pair, never just its
 *  secret. `next` is the full endpoint list the write leaves behind. */
function commit(next: CustomProviderSettings[], endpoint: { id: string; binding?: CustomAuthBinding; fileKey?: string; clear?: boolean }): void {
	const latest = readSettings() ?? { version: 1 };
	// The rollback needs the endpoint's OWN pair as it was, key included — not
	// the effective credential, which may belong to the environment.
	const oldAuth = endpoint.clear || endpoint.binding ? readCustomAuth(endpoint.id) : undefined;
	let published = false;
	try {
		if (endpoint.clear) { persistCustomAuth(endpoint.id, undefined, undefined); published = true; }
		else if (endpoint.binding) { persistCustomAuth(endpoint.id, endpoint.binding, endpoint.fileKey); published = true; }
		const { customProvider: _legacy, ...rest } = latest;
		writeSettings(next.length ? { ...rest, customProviders: next } : rest);
	} catch {
		if (published) {
			try {
				persistCustomAuth(endpoint.id, oldAuth?.binding, oldAuth?.fileKey());
			} catch { /* durable nonce mismatch fails closed after restart */ }
		}
		throw new Error("Unable to save custom configuration. Reload configuration and retry.");
	}
	syncCustomProvider();
}

/** The id a new endpoint takes: never the legacy `custom`, always the same
 *  shape the sanitizer accepts. */
function freshId(taken: readonly CustomProviderSettings[]): string | undefined {
	for (let attempt = 0; attempt < 8; attempt++) {
		const id = `custom-${randomBytes(4).toString("hex")}`;
		if (!taken.some((cp) => cp.id === id)) return id;
	}
	return undefined;
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
		const target = typeof raw.id === "string" ? raw.id.trim() : "";
		if (target && !isCustomProviderId(target)) return failure("Unknown custom endpoint.");
		const before = snapshot(raw.authMode === "apiKey");
		if (before.endpoints.some((e) => !e.auth.readable)) return failure("Custom authorization storage is unavailable. No changes were saved.", 500);
		if (request.headers.get("if-match") !== before.etag) return stale();
		const list = before.endpoints.map((e) => e.cp);
		const at = (id: string) => list.findIndex((cp) => cp.id === id);
		// A DELETE (or a pin edit) that names nothing means the only endpoint
		// there is — the single-endpoint era's client, still meaning one thing.
		// With two or more stored, an unnamed write is ambiguous and refused.
		const previous = target
			? before.endpoints[at(target)]
			: (request.method === "DELETE" || request.method === "PATCH") && list.length === 1 ? before.endpoints[0] : undefined;
		// A named endpoint that is not stored is not "new": the client sent an
		// id it read before some other write removed it.
		const creating = target === "";
		if (!creating && !previous) return stale();
		if (request.method === "DELETE") {
			if (!previous) return failure("Unknown custom endpoint.", 404);
			commit(list.filter((cp) => cp.id !== previous.cp.id), { id: previous.cp.id, clear: true });
			return response({ ok: true }, snapshot().etag);
		}
		if (request.method === "PATCH") {
			const parsed = parseCustomModelOverridesBody(raw);
			if (!parsed.ok) return failure(parsed.error);
			if (!previous) return failure("Unknown custom endpoint.", 404);
			if (!previous.cp.baseUrl) return failure("No custom endpoint configured", 409);
			const overrides = sanitizeCustomModelOverrides(parsed.settings, previous.cp.models?.map((m) => m.id));
			commit(list.map((cp) => (cp.id === previous.cp.id ? { ...cp, overrides } : cp)), { id: previous.cp.id });
			return response({ ok: true, id: previous.cp.id, overrides }, snapshot().etag);
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		// A POST with no URL is a rename: the endpoint keeps its address, key,
		// and models, so renaming never needs the server to be running.
		if (raw.baseUrl === undefined) {
			if (!previous) return failure("A new custom endpoint needs a base URL.");
			if (typeof raw.name !== "string") return failure("Name must be a string.");
			const renamed = raw.name.replace(/\s+/g, " ").trim();
			commit(
				list.map((cp) => {
					if (cp.id !== previous.cp.id) return cp;
					const { name: _old, ...rest } = cp;
					return renamed ? { ...rest, name: renamed } : rest;
				}),
				{ id: previous.cp.id },
			);
			const next = readSettings()?.customProviders?.find((cp) => cp.id === previous.cp.id) ?? previous.cp;
			return response({ ok: true, id: next.id, name: customProviderName(next), models: next.models ?? [] }, snapshot().etag);
		}
		if (creating && list.length >= CUSTOM_PROVIDER_LIMIT) return failure(`A record holds at most ${CUSTOM_PROVIDER_LIMIT} custom endpoints.`);
		const id = creating ? freshId(list) : previous!.cp.id;
		if (!id) return failure("Unable to allocate an endpoint id. Retry.", 500);
		const base = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
		if (!base) return failure("Base URL must be http(s), with no credentials, query or fragment.");
		if (raw.authMode !== "keyless" && raw.authMode !== "apiKey") return failure("Choose Keyless or API key authentication.");
		const authMode = raw.authMode;
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("API key must be a string.");
		if (raw.name !== undefined && typeof raw.name !== "string") return failure("Name must be a string.");
		const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : undefined;
		const supplied = typeof raw.key === "string" ? raw.key.trim() : undefined;
		if (authMode === "apiKey" && supplied === "") return failure("Choose Keyless to clear authentication.");
		const priorAuth: CustomAuthState = previous?.auth ?? { readable: true, source: "none" };
		const envOwned = priorAuth.source === "env";
		if (envOwned && supplied) return failure("Environment owns the effective key. Change the environment or explicitly reuse that key.");
		// A shadowed file key is not the key that will run. Require consent for
		// the actual environment key when authorizing a different endpoint.
		const hasNewEffectiveKey = Boolean(supplied) && !envOwned;
		const changedTarget = previous?.cp.baseUrl !== base;
		if (authMode === "apiKey" && (changedTarget || !customKeyAuthorized(previous?.cp, priorAuth)) && !hasNewEffectiveKey && raw.reuseKey !== true) {
			return failure("Enter a new key or explicitly allow reuse of the effective existing key for this URL.");
		}
		const effectiveKey = authMode === "apiKey" ? (envOwned ? priorAuth.key : supplied || priorAuth.key) : undefined;
		if (authMode === "apiKey" && !effectiveKey) return failure("API key mode requires an effective key.");
		const manualModels = parseModelIds(raw.manualModels);
		if (manualModels.length > 10_000) return failure("Model list exceeds 10000 entries");
		const found = await discoverModels(base, effectiveKey);
		if (!found.ok && (found.fatal || found.status === 401 || found.status === 403)) return failure(found.error, 502);
		if (!found.ok && !manualModels.length) return failure(`${found.error}. If this endpoint has no /models list, add model IDs manually.`, 502);
		// Discovery yields; the whole record and the credential must still
		// match. Unrelated settings edits are preserved by commit's fresh merge.
		const now = snapshot(authMode === "apiKey");
		const nowPrevious = now.endpoints.find((e) => e.cp.id === id);
		if (now.etag !== before.etag || JSON.stringify(nowPrevious?.auth ?? null) !== JSON.stringify(previous?.auth ?? null)) return stale();
		const discovered = found.ok ? found.models : !changedTarget ? previous?.cp.models ?? [] : [];
		const models = mergeManualModels(discovered, manualModels);
		if (models.length > 10_000) return failure("Model list exceeds 10000 entries");
		const overrides = sanitizeCustomModelOverrides(!changedTarget ? previous?.cp.overrides : undefined, models.map((m) => m.id));
		const binding: CustomAuthBinding = { version: 1, id: randomBytes(16).toString("hex"), providerId: id, baseUrl: base, authMode };
		const fileKey = authMode === "keyless" ? undefined : envOwned ? priorAuth.fileKey : supplied ?? priorAuth.fileKey;
		// A file key keeps the destination it belongs to: this URL, unless an
		// environment key owns the endpoint and the file key is only shadowed.
		const fileKeyBaseUrl = authMode !== "apiKey" ? undefined : envOwned ? priorAuth.binding?.fileKeyBaseUrl : base;
		if (fileKey && fileKeyBaseUrl) binding.fileKeyBaseUrl = fileKeyBaseUrl;
		const entry: CustomProviderSettings = {
			id,
			...(name ? { name } : {}),
			baseUrl: base,
			authMode,
			credentialBindingId: binding.id,
			models,
			overrides,
			...(manualModels.length ? { manualModels } : {}),
		};
		const next = creating ? [...list, entry] : list.map((cp) => (cp.id === id ? entry : cp));
		commit(next, { id, binding, fileKey });
		return response({ ok: true, id, name: customProviderName(entry), models }, snapshot().etag);
	} catch (error) {
		return failure(error instanceof CustomBodyLimitError ? "Configuration body exceeds 64 KiB." : error instanceof SyntaxError ? "Invalid JSON body." : "Unable to save custom configuration. Reload configuration and retry.", error instanceof CustomBodyLimitError ? 413 : error instanceof SyntaxError ? 400 : 500);
	}
}

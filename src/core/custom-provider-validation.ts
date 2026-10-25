/**
 * Pure validation for user-defined (custom) providers. No I/O, no network,
 * no DNS: the base URL is judged on its text only.
 *
 * Base URL policy:
 *  - http/https only; no userinfo, query or fragment (raw text is checked,
 *    so an empty "?" or "#" is also rejected).
 *  - https is required for every remote host. Plain http is allowed only for
 *    explicit loopback: `localhost`, a canonical dotted-quad in 127.0.0.0/8,
 *    or `[::1]`.
 *  - Ambiguous spellings are rejected, not normalized: short/octal/hex/decimal
 *    IPv4 forms (127.1, 0x7f.0.0.1, 2130706433, 0177.0.0.1), a trailing-dot
 *    host (`localhost.`), and `0.0.0.0` / `[::]`.
 *  - Cloud metadata and link-local targets are always blocked, over http and
 *    https: 169.254.0.0/16, 100.100.100.200, fe80::/10, fd00:ec2::254,
 *    metadata.google.internal, and every IPv4-mapped/compatible IPv6 literal
 *    (::ffff:a.b.c.d and ::a.b.c.d, in any spelling).
 *  - DNS names are not resolved here, so a name that resolves to a blocked
 *    address is out of scope for this module.
 */

import type {
	CustomModelDefinition,
	CustomProviderApi,
	CustomProviderDefinition,
} from "./provider-connections.ts";

export const CUSTOM_PROVIDER_API_VALUES: readonly CustomProviderApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
];
export const CUSTOM_PROVIDER_ID_PREFIX = "custom-";
export const MAX_CUSTOM_PROVIDER_ID_LENGTH = 64;
export const MAX_CUSTOM_PROVIDER_NAME_LENGTH = 80;
export const MAX_CUSTOM_BASE_URL_LENGTH = 2048;
export const MAX_CUSTOM_MODELS = 64;
export const MAX_CUSTOM_MODEL_ID_LENGTH = 200;
export const MAX_CUSTOM_MODEL_NAME_LENGTH = 120;
/** Longest accepted API key, in UTF-16 code units. */
export const MAX_CUSTOM_API_KEY_LENGTH = 4096;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const ID_RE = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}
function exactKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): string | null {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${what}: unknown field "${k.slice(0, 40)}"`;
	return null;
}
function text(v: unknown, max: number, what: string): Validated<string> {
	if (typeof v !== "string") return fail(`${what} must be a string`);
	const t = v.trim();
	if (!t) return fail(`${what} must not be empty`);
	if (t.length > max) return fail(`${what} must be at most ${max} characters`);
	if (CONTROL_RE.test(t)) return fail(`${what} must not contain control characters`);
	return { ok: true, value: t };
}

export function isCustomProviderId(id: unknown): id is string {
	return typeof id === "string" && id.length <= MAX_CUSTOM_PROVIDER_ID_LENGTH && ID_RE.test(id);
}

// ── base URL ────────────────────────────────────────────────────────────

const STRICT_V4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function ipv4Octets(h: string): number[] | null {
	return STRICT_V4.test(h) ? h.split(".").map(Number) : null;
}

/** Reject any IPv6 literal that embeds IPv4 (mapped/compatible/translated). */
function isEmbeddedV4(h6: string): boolean {
	// h6 is the URL-normalized form without brackets, e.g. "::ffff:7f00:1".
	if (/^(?:0{1,4}:){5}ffff:/i.test(h6) || /^::ffff:/i.test(h6)) return true;
	if (/^::(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|\d+\.\d+\.\d+\.\d+)$/i.test(h6)) return h6 !== "::1" && h6 !== "::";
	if (/^64:ff9b:/i.test(h6)) return true;
	return false;
}

function isBlockedV6(h6: string): boolean {
	const lower = h6.toLowerCase();
	if (isEmbeddedV4(lower)) return true;
	const first = parseInt(lower.split(":")[0] || "0", 16);
	if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
	if (lower === "fd00:ec2::254") return true; // AWS IPv6 metadata
	return false;
}

/**
 * Validates and normalizes a base URL. The normalized form is
 * `scheme://host[:port]/path` with no trailing slash, and is what is stored
 * and compared for endpoint-change detection.
 */
export function validateCustomBaseUrl(input: unknown): Validated<string> {
	if (typeof input !== "string") return fail("baseUrl must be a string");
	const raw = input.trim();
	if (!raw) return fail("baseUrl must not be empty");
	if (raw.length > MAX_CUSTOM_BASE_URL_LENGTH) return fail("baseUrl is too long");
	if (CONTROL_RE.test(raw) || /\s/.test(raw) || raw.includes("\\")) return fail("baseUrl contains invalid characters");
	if (raw.includes("?") || raw.includes("#")) return fail("baseUrl must not include a query or fragment");
	const m = /^(https?):\/\/([^/]*)(\/.*)?$/i.exec(raw);
	if (!m) return fail("baseUrl must be an http or https URL");
	const scheme = (m[1] ?? "").toLowerCase();
	const authority = m[2] ?? "";
	if (authority.includes("@")) return fail("baseUrl must not include credentials");
	let rawHost: string;
	if (authority.startsWith("[")) {
		const end = authority.indexOf("]");
		if (end < 0) return fail("baseUrl host is invalid");
		rawHost = authority.slice(0, end + 1);
		const rest = authority.slice(end + 1);
		if (rest && !/^:\d{1,5}$/.test(rest)) return fail("baseUrl port is invalid");
	} else {
		const colon = authority.lastIndexOf(":");
		rawHost = colon >= 0 ? authority.slice(0, colon) : authority;
		const port = colon >= 0 ? authority.slice(colon + 1) : "";
		if (colon >= 0 && !/^\d{1,5}$/.test(port)) return fail("baseUrl port is invalid");
	}
	if (!rawHost) return fail("baseUrl host is missing");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return fail("baseUrl is not a valid URL");
	}
	if (url.username || url.password) return fail("baseUrl must not include credentials");
	if (url.search || url.hash) return fail("baseUrl must not include a query or fragment");

	const hostLower = rawHost.toLowerCase();
	let loopback = false;
	if (hostLower.startsWith("[")) {
		const h6 = url.hostname.slice(1, -1).toLowerCase();
		if (h6 === "::") return fail("baseUrl host is not allowed");
		if (isBlockedV6(h6)) return fail("baseUrl host is a blocked address");
		loopback = h6 === "::1";
		if (loopback && hostLower !== "[::1]") return fail("loopback must be written exactly as [::1]");
	} else {
		const labels = hostLower.split(".");
		const last = labels[labels.length - 1] ?? "";
		const numericish = /^(?:\d+|0x[0-9a-f]*)$/.test(last);
		if (numericish || STRICT_V4.test(hostLower)) {
			const oct = ipv4Octets(hostLower);
			if (!oct) return fail("baseUrl IPv4 address must be written as a plain dotted quad");
			if (oct[0] === 0) return fail("baseUrl host is not allowed");
			if (oct[0] === 169 && oct[1] === 254) return fail("baseUrl host is a blocked address");
			if (hostLower === "100.100.100.200") return fail("baseUrl host is a blocked address");
			loopback = oct[0] === 127;
		} else {
			if (hostLower.endsWith(".")) return fail("baseUrl host must not end with a dot");
			if (hostLower === "metadata.google.internal" || hostLower === "metadata") return fail("baseUrl host is a blocked address");
			if (hostLower === "localhost") loopback = true;
			else if (hostLower.endsWith(".localhost") || hostLower.endsWith(".local")) return fail("baseUrl host is not allowed");
			if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(hostLower)) return fail("baseUrl host is invalid");
		}
	}
	if (scheme === "http" && !loopback) return fail("baseUrl must use https unless it is a loopback address");
	const path = url.pathname.replace(/\/+$/, "");
	return { ok: true, value: `${url.protocol}//${url.host}${path}` };
}

// ── models / provider ───────────────────────────────────────────────────

function positiveInt(v: unknown, what: string): Validated<number> {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return fail(`${what} must be a positive integer`);
	return { ok: true, value: v };
}

function validateModel(input: unknown, i: number): Validated<CustomModelDefinition> {
	const w = `models[${i}]`;
	if (!isRecord(input)) return fail(`${w} must be an object`);
	const bad = exactKeys(input, ["id", "name", "contextWindow", "maxTokens", "input", "reasoning", "cost"], w);
	if (bad) return fail(bad);
	const id = text(input.id, MAX_CUSTOM_MODEL_ID_LENGTH, `${w}.id`);
	if (!id.ok) return id;
	const name = text(input.name, MAX_CUSTOM_MODEL_NAME_LENGTH, `${w}.name`);
	if (!name.ok) return name;
	const ctx = positiveInt(input.contextWindow, `${w}.contextWindow`);
	if (!ctx.ok) return ctx;
	const max = positiveInt(input.maxTokens, `${w}.maxTokens`);
	if (!max.ok) return max;
	if (!Array.isArray(input.input) || input.input.length === 0) return fail(`${w}.input must be a non-empty array`);
	const kinds: ("text" | "image")[] = [];
	for (const k of input.input) {
		if (k !== "text" && k !== "image") return fail(`${w}.input entries must be "text" or "image"`);
		if (kinds.includes(k)) return fail(`${w}.input must not repeat entries`);
		kinds.push(k);
	}
	if (typeof input.reasoning !== "boolean") return fail(`${w}.reasoning must be a boolean`);
	const model: CustomModelDefinition = {
		id: id.value,
		name: name.value,
		contextWindow: ctx.value,
		maxTokens: max.value,
		input: kinds,
		reasoning: input.reasoning,
	};
	if (input.cost !== undefined) {
		if (!isRecord(input.cost)) return fail(`${w}.cost must be an object`);
		const badCost = exactKeys(input.cost, ["input", "output", "cacheRead", "cacheWrite"], `${w}.cost`);
		if (badCost) return fail(badCost);
		const c = input.cost;
		for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const n = c[k];
			if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e6) return fail(`${w}.cost.${k} must be a number from 0 to 1000000`);
		}
		model.cost = { input: c.input as number, output: c.output as number, cacheRead: c.cacheRead as number, cacheWrite: c.cacheWrite as number };
	}
	return { ok: true, value: model };
}

/** Validates an untrusted value into an exact, normalized definition. */
export function validateCustomProviderDefinition(input: unknown): Validated<CustomProviderDefinition> {
	if (!isRecord(input)) return fail("provider must be an object");
	const bad = exactKeys(input, ["id", "name", "baseUrl", "api", "keyless", "models"], "provider");
	if (bad) return fail(bad);
	if (!isCustomProviderId(input.id)) {
		return fail(`provider id must be lowercase letters, digits and single hyphens, start with "${CUSTOM_PROVIDER_ID_PREFIX}", and be at most ${MAX_CUSTOM_PROVIDER_ID_LENGTH} characters`);
	}
	const name = text(input.name, MAX_CUSTOM_PROVIDER_NAME_LENGTH, "name");
	if (!name.ok) return name;
	const baseUrl = validateCustomBaseUrl(input.baseUrl);
	if (!baseUrl.ok) return baseUrl;
	if (!CUSTOM_PROVIDER_API_VALUES.includes(input.api as CustomProviderApi)) {
		return fail(`api must be one of ${CUSTOM_PROVIDER_API_VALUES.join(", ")}`);
	}
	if (typeof input.keyless !== "boolean") return fail("keyless must be a boolean");
	if (!Array.isArray(input.models) || input.models.length === 0) return fail("models must be a non-empty array");
	if (input.models.length > MAX_CUSTOM_MODELS) return fail(`models may hold at most ${MAX_CUSTOM_MODELS} entries`);
	const models: CustomModelDefinition[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < input.models.length; i++) {
		const m = validateModel(input.models[i], i);
		if (!m.ok) return m;
		if (seen.has(m.value.id)) return fail(`models[${i}].id is a duplicate`);
		seen.add(m.value.id);
		models.push(m.value);
	}
	return {
		ok: true,
		value: { id: input.id, name: name.value, baseUrl: baseUrl.value, api: input.api as CustomProviderApi, keyless: input.keyless, models },
	};
}

/** API keys are opaque: no trimming surprises, but no control characters
 *  (header injection) and a hard length cap. Errors never echo the key. */
export function validateCustomApiKey(input: unknown): Validated<string> {
	if (typeof input !== "string") return fail("apiKey must be a string");
	if (input.length > MAX_CUSTOM_API_KEY_LENGTH) return fail(`apiKey must be at most ${MAX_CUSTOM_API_KEY_LENGTH} characters`);
	const key = input.trim();
	if (!key) return fail("apiKey must not be empty");
	if (CONTROL_RE.test(key)) return fail("apiKey must not contain control characters");
	return { ok: true, value: key };
}

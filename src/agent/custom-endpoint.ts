/**
 * CUSTOM OPENAI-COMPATIBLE ENDPOINT (fork addition): one user-configured
 * base URL (an LLM router, LiteLLM, vLLM, Ollama, OpenRouter-compatible
 * gateway — anything speaking /chat/completions) registered as the
 * `custom` pi-ai provider, so every slot/role/per-session pick can point
 * at models the built-in catalog does not know.
 *
 * STORAGE: `data/endpoint.json`, one small record (base url + the model
 * list fetched from GET {base}/models). The KEY is not here — it rides
 * the keys seam under the fixed env var CUSTOM_ENDPOINT_API_KEY, so the
 * existing auth.json / .env precedence, masking and status rows apply
 * unchanged.
 *
 * MATCHING: pi-ai resolves a provider per request by the model's
 * `provider` id. The provider takes whatever the current record says, so
 * a saved endpoint change is live for the NEXT request with no restart
 * (the same discipline as the keys seam). Six places identify a pick by
 * `{provider, id}` — the six: getModel/stream, the slot and role
 * validators, the picker catalog, the context-limit index, the cost
 * table, and the first-run/slot "configured" gate. This record is the one
 * source they all read; a `custom` id that is not in the record resolves
 * nothing (honest null, never a phantom).
 *
 * URL DISCIPLINE: the base URL is normalized (trailing slash stripped,
 * `/v1` assumed only when the user typed a bare host) because the chat
 * handler appends `/chat/completions`; `<base>/models` is what discovery
 * fetches. Both http(s) only — a shipped desktop app has no reason to
 * reach a file server.
 */

import path from "node:path";
import { PATHS } from "../../config.ts";

export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_PROVIDER_LABEL = "Custom endpoint";
/** The key rides the keys seam under this fixed name. */
export const CUSTOM_ENDPOINT_KEY_VAR = "CUSTOM_ENDPOINT_API_KEY";
export const CUSTOM_ENDPOINT_FILE = path.join(PATHS.data, "endpoint.json");

/** One discovered model, as stored. */
export interface CustomModel {
	id: string;
	name: string;
	/** Context window the endpoint advertises (`context_length`,
	 *  `max_model_len`, `max_input_tokens`); undefined = unknown → the
	 *  catalog reports 0 (usage-only context meter, pi's honest default). */
	contextWindow?: number;
	/** Vision input (declared `modalities.input` containing "image"). */
	vision?: boolean;
}

/** The stored record. `baseUrl` empty = no endpoint configured. */
export interface CustomEndpoint {
	baseUrl: string;
	models: CustomModel[];
	updatedAt: string;
}

export const EMPTY_ENDPOINT: CustomEndpoint = { baseUrl: "", models: [], updatedAt: "" };

/**
 * THE LIVE RECORD (the chatgpt-bridge precedent): the agent layer must not
 * import the store, so the store PUSHES the current record in here instead
 * — at boot (hydrate) and after every save/clear. The provider reads this
 * on each call, which is what makes a URL change live for the next request
 * with no restart (the keys seam's immediacy, for the same reason).
 */
const STATE_KEY = Symbol.for("lh.customEndpoint");
const global = globalThis as typeof globalThis & { [STATE_KEY]?: CustomEndpoint };

export function currentEndpoint(): CustomEndpoint {
	return global[STATE_KEY] ?? EMPTY_ENDPOINT;
}

export function setCurrentEndpoint(record: CustomEndpoint): void {
	global[STATE_KEY] = record;
}

export function customEndpointConfigured(record: CustomEndpoint | undefined | null): boolean {
	return Boolean(record?.baseUrl && record.models.length);
}

/**
 * Normalize a typed base URL: trim, drop trailing slashes, add `/v1` when
 * the user pasted a bare origin (llmrouter.boyemma.com → .../v1). Keeps
 * the path as typed otherwise (a gateway may mount elsewhere). Null when
 * it is not an http(s) URL.
 */
export function normalizeEndpointUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	const pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = pathname === "" ? "/v1" : pathname;
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString().replace(/\/+$/, "");
}

/** `<base>/models` — the discovery call. */
export function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/**
 * Read an endpoint's GET /models payload into records. Accepts the OpenAI
 * shape ({data:[{id}]}) and the bare array some local servers return.
 * Metadata is best-effort (context window / vision), never required.
 */
export function parseModelList(payload: unknown): CustomModel[] {
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray((payload as { data?: unknown })?.data)
			? (payload as { data: unknown[] }).data
			: [];
	const seen = new Set<string>();
	const models: CustomModel[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const raw = row as Record<string, unknown>;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const contextWindow = [
			raw.context_length,
			raw.max_model_len,
			raw.max_input_tokens,
			(raw as { limits?: Record<string, unknown> }).limits?.context,
		].find((v): v is number => typeof v === "number" && v > 0);
		const modalities = (raw as { modalities?: { input?: unknown[] } }).modalities?.input;
		const vision = Array.isArray(modalities) && modalities.includes("image");
		models.push({ id, name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id, ...(contextWindow ? { contextWindow } : {}), ...(vision ? { vision } : {}) });
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * LOCAL MODEL SERVERS (local-models wave, 2026-10-24): self-hosted
 * inference servers — Ollama, llama.cpp, vLLM, LM Studio, or ANY endpoint
 * speaking one of the three supported wire protocols (known engines only
 * add richer metadata; nothing requires one) — joined to the model
 * catalog as first-class providers. The user gives an address and an API
 * type; the server itself is the source of truth for which models exist and
 * what each can do (context length, image input, reasoning). The agent
 * layer asks it (src/agent/local-models.ts); this module only holds the
 * shapes and the pure rules both sides share.
 *
 * Storage follows the house split: the server list (non-secret) lives in
 * the settings record's `localServers` section; an optional API key lives
 * in auth.json under a per-server env-var name (localServerKeyVar) so it
 * rides the same env seam every other key does (src/server/keys.ts).
 *
 * PURE, browser-safe — no fs, no env, no network.
 */

/** The wire protocols a local server can speak — each one is a pi-ai API
 *  implementation (openai-completions covers nearly every local engine). */
export const LOCAL_SERVER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type LocalServerApi = (typeof LOCAL_SERVER_APIS)[number];

export const LOCAL_SERVER_API_LABELS: Readonly<Record<LocalServerApi, string>> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
};

/** The engines discovery recognizes (each has its own metadata endpoint
 *  beyond /v1/models). null = an unrecognized compatible server. */
export const LOCAL_ENGINES = ["ollama", "llamacpp", "vllm", "lmstudio", "sglang"] as const;
export type LocalEngine = (typeof LOCAL_ENGINES)[number];

export const LOCAL_ENGINE_LABELS: Readonly<Record<LocalEngine, string>> = {
	ollama: "Ollama",
	llamacpp: "llama.cpp",
	vllm: "vLLM",
	lmstudio: "LM Studio",
	sglang: "SGLang",
};

/** One-click address presets — each engine's default port. */
export interface LocalServerPreset {
	engine: LocalEngine;
	address: string;
	api: LocalServerApi;
}
export const LOCAL_SERVER_PRESETS: readonly LocalServerPreset[] = [
	{ engine: "ollama", address: "localhost:11434", api: "openai-completions" },
	{ engine: "llamacpp", address: "localhost:8080", api: "openai-completions" },
	{ engine: "vllm", address: "localhost:8000", api: "openai-completions" },
	{ engine: "lmstudio", address: "localhost:1234", api: "openai-completions" },
];

/** One configured server — the settings record's `localServers` entry. */
export interface LocalServer {
	/** The pi provider id, fixed at creation — model pins reference it
	 *  ({provider: id, id: modelId}), so it never changes on edit. */
	id: string;
	/** Display label (the detected engine's name, else the host). */
	name: string;
	/** The normalized API base (normalizeLocalServerUrl). */
	baseUrl: string;
	api: LocalServerApi;
	/** Context-window override for every model on this server. Absent =
	 *  the length each model's server reports. */
	contextWindow?: number;
	/** Image-input override for every model on this server. Absent = what
	 *  the server reports per model (text-only when it reports nothing). */
	vision?: boolean;
	/** Model ids the user named. Always offered alongside whatever the
	 *  server lists — the way to use an endpoint that has no model list
	 *  (or does not list a model it serves). Absent = the server's list. */
	models?: string[];
}

/** The smallest context-window override accepted — anything below cannot
 *  hold the agents' own instructions. */
export const LOCAL_CONTEXT_WINDOW_FLOOR = 2048;

// ─── API contract (GET/POST /api/local-servers) ─────────────────────────────

/** One model as the picker would run it (server report + overrides). */
export interface LocalModelInfo {
	id: string;
	contextWindow: number;
	vision: boolean;
	reasoning: boolean;
}

/** The last discovery against one server. */
export interface LocalServerStatus {
	ok: boolean;
	engine: LocalEngine | null;
	/** The usable chat models (empty when the last check failed and no
	 *  earlier list exists). */
	models: LocalModelInfo[];
	/** Models the server listed that cannot run an agent, with the reason. */
	hidden: { id: string; reason: string }[];
	/** Why the last check failed — present only when ok is false. */
	error?: string;
	checkedAt: number;
}

/** GET /api/local-servers row: the config, the display address, whether a
 *  key is stored (never the key), and the last discovery (null = never). */
export interface LocalServerView extends LocalServer {
	address: string;
	apiKeySet: boolean;
	status: LocalServerStatus | null;
}

/** POST /api/local-servers body — connect a new server (no id) or update
 *  one (id). Tri-state optionals: a value sets, null clears, absent keeps. */
export interface LocalServerInput {
	id?: string;
	address: string;
	api: LocalServerApi;
	apiKey?: string | null;
	contextWindow?: number | null;
	vision?: boolean | null;
	models?: string[] | null;
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

export function isLocalServerApi(value: unknown): value is LocalServerApi {
	return typeof value === "string" && (LOCAL_SERVER_APIS as readonly string[]).includes(value);
}

/**
 * The address field → the API base pi-ai calls. Accepts "localhost:11434",
 * "192.168.1.5:8000", or a full URL with a custom path (proxies). The
 * scheme defaults to http://. OpenAI-style bases need the /v1 segment (the
 * SDK appends /chat/completions), so a bare host gains it; Anthropic-style
 * bases must NOT carry it (the SDK appends /v1/messages), so a trailing
 * /v1 is dropped.
 */
export function normalizeLocalServerUrl(
	address: string,
	api: LocalServerApi,
): { ok: true; baseUrl: string } | { ok: false; error: string } {
	const trimmed = address.trim();
	if (!trimmed) return { ok: false, error: "Enter the server address, e.g. localhost:11434" };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return { ok: false, error: `"${trimmed}" is not a valid address` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, error: "The address must use http:// or https://" };
	}
	let pathname = url.pathname.replace(/\/+$/, "");
	if (api === "anthropic-messages") pathname = pathname.replace(/\/v1$/, "");
	else if (pathname === "") pathname = "/v1";
	return { ok: true, baseUrl: `${url.protocol}//${url.host}${pathname}` };
}

/** The Model IDs field → ids: split on commas and whitespace, trimmed,
 *  first occurrence kept. */
export function parseModelIds(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** The base URL back to what a person types: host:port, plus any custom
 *  path that is not the default /v1. */
export function displayAddress(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		const pathname = url.pathname.replace(/\/+$/, "");
		const shown = pathname === "/v1" || pathname === "" ? "" : pathname;
		return `${url.protocol === "https:" ? "https://" : ""}${url.host}${shown}`;
	} catch {
		return baseUrl;
	}
}

/** The auth.json / env-var name holding one server's optional API key. */
export function localServerKeyVar(id: string): string {
	return `LOCAL_SERVER_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Is this env-var name a local server's key slot? */
export function isLocalServerKeyVar(name: string): boolean {
	return /^LOCAL_SERVER_[A-Z0-9_]+_API_KEY$/.test(name);
}

const LOCAL_SERVER_ID = /^[a-z0-9][a-z0-9-]*$/;

/** A fresh provider id for a new server: the engine (or "local") slug,
 *  suffixed -2, -3… past every id already taken (built-in providers
 *  included — a local id must never shadow one). */
export function localServerIdFor(base: string, taken: ReadonlySet<string>): string {
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "local";
	if (!taken.has(slug)) return slug;
	for (let n = 2; ; n++) {
		const candidate = `${slug}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** The settings sanitizer for the `localServers` section (the core/
 *  settings.ts discipline: never throws, invalid entries drop, duplicate
 *  ids keep the first). undefined = nothing valid to keep. */
export function sanitizeLocalServers(raw: unknown): LocalServer[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: LocalServer[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const r = entry as Record<string, unknown>;
		if (typeof r.id !== "string" || !LOCAL_SERVER_ID.test(r.id) || seen.has(r.id)) continue;
		if (typeof r.name !== "string" || !r.name.trim()) continue;
		if (!isLocalServerApi(r.api)) continue;
		if (typeof r.baseUrl !== "string" || !/^https?:\/\//.test(r.baseUrl)) continue;
		const server: LocalServer = { id: r.id, name: r.name, baseUrl: r.baseUrl, api: r.api };
		if (typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow)) {
			server.contextWindow = Math.max(LOCAL_CONTEXT_WINDOW_FLOOR, Math.floor(r.contextWindow));
		}
		if (typeof r.vision === "boolean") server.vision = r.vision;
		if (Array.isArray(r.models)) {
			const models = [...new Set(r.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()))];
			if (models.length) server.models = models;
		}
		seen.add(r.id);
		out.push(server);
	}
	return out.length ? out : undefined;
}

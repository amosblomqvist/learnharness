/**
 * LOCAL MODEL SERVERS — the engine side (local-models wave, 2026-10-24):
 * ask a self-hosted server which models it serves and what each one can
 * do, and build the pi-ai provider that streams to it.
 *
 * THE SERVER IS THE TRUTH. An agent harness lives or dies by the model's
 * real limits — a context window guessed too large silently truncates the
 * agents' instructions on the server; one guessed too small starves every
 * answer — so discovery reads what each engine actually reports:
 *   - every server: GET /v1/models (the id list; vLLM/SGLang add
 *     max_model_len, llama.cpp adds meta.n_ctx_train);
 *   - llama.cpp: GET /props — the RUNTIME slot context (n_ctx) and the
 *     loaded projector's vision modality;
 *   - Ollama: POST /api/show per model — capabilities (completion, tools,
 *     vision, thinking), the Modelfile's num_ctx, the trained length — and
 *     GET /api/ps for the context a loaded model actually runs with;
 *   - LM Studio: GET /api/v0/models — type (llm / vlm / embeddings) and
 *     the loaded or maximum context length.
 *   - ANY other OpenAI- or Anthropic-compatible endpoint: its list alone
 *     (any context field it carries), and model ids the user names when
 *     the endpoint has no list at all.
 * Models a server says cannot run an agent (embedding-only, no tool
 * calling) are hidden with the reason, not offered to fail later.
 * Sampling parameters are never sent: each server's own defaults (its
 * Modelfile, launch flags, preset) apply as configured there.
 *
 * Layering: no settings or key-store reads — the server layer
 * (src/server/local-servers.ts) passes the config and key in. Pure
 * network + pi wiring, so tests drive it against fixture servers.
 */

import { createProvider, type Api, type Model, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { LocalEngine, LocalServer, LocalServerApi } from "../core/local-servers.ts";

/** The context window assumed when neither the server nor the user names
 *  one (generic servers, or a model whose metadata probe failed). */
export const LOCAL_DEFAULT_CONTEXT_WINDOW = 32_768;

/** How long one discovery may take end to end (listing + engine probes). */
export const LOCAL_DISCOVERY_TIMEOUT_MS = 8_000;

/** Sent as the API key to a server configured without one: the OpenAI and
 *  Anthropic clients refuse to send a request with no key at all, and a
 *  keyless server ignores whatever arrives. */
export const KEYLESS_API_KEY = "no-key";

/** One model as its server reported it — before the user's overrides. */
export interface DiscoveredModel {
	id: string;
	name?: string;
	contextWindow?: number;
	vision?: boolean;
	reasoning?: boolean;
}

export interface LocalDiscovery {
	engine: LocalEngine | null;
	/** An unrecognized server's own name for itself — the `owned_by` all
	 *  its list entries share (e.g. "my-engine"), when it is not one of the
	 *  generic placeholders. Names the server; never changes behavior. */
	owner?: string;
	models: DiscoveredModel[];
	hidden: { id: string; reason: string }[];
}

/** A failed discovery — the message is user-facing as-is. `code` says
 *  which way it failed: the server was not reached, refused the key, or
 *  answered without a model list (the one failure named model ids cure). */
export class LocalServerError extends Error {
	constructor(
		message: string,
		readonly code: "unreachable" | "auth" | "no-list",
	) {
		super(message);
		this.name = "LocalServerError";
	}
}

// ─── Discovery ───────────────────────────────────────────────────────────────

interface Probe {
	fetch: typeof fetch;
	signal: AbortSignal;
	headers: Record<string, string>;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The first argument that is a positive integer (string digits allowed —
 *  some servers stringify numbers). */
function firstPositiveInt(...values: unknown[]): number | undefined {
	for (const value of values) {
		const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
		if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
	}
	return undefined;
}

/** The API base minus its /v1 segment — where engine-specific endpoints
 *  (/props, /api/show, /api/v0/models) live. */
function serverRoot(baseUrl: string): string {
	return baseUrl.replace(/\/v1$/, "");
}

function authHeaders(api: LocalServerApi, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	if (api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
		if (api === "anthropic-messages") headers["x-api-key"] = apiKey;
	}
	return headers;
}

/** A best-effort metadata probe: any failure (404 on another engine,
 *  timeout, junk body) reads as "this server does not say". */
async function tryJson(probe: Probe, url: string, body?: unknown): Promise<Json | undefined> {
	try {
		const res = await probe.fetch(url, {
			method: body === undefined ? "GET" : "POST",
			headers: body === undefined ? probe.headers : { ...probe.headers, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: probe.signal,
		});
		if (!res.ok) return undefined;
		const json: unknown = await res.json();
		return isRecord(json) ? json : undefined;
	} catch {
		return undefined;
	}
}

/** One list entry → a record with a string `id` (servers name it id,
 *  name, or model; a bare string is an id too). */
function listEntry(raw: unknown): Json | undefined {
	if (typeof raw === "string") return raw ? { id: raw } : undefined;
	if (!isRecord(raw)) return undefined;
	const id = [raw.id, raw.name, raw.model].find((v): v is string => typeof v === "string" && v.length > 0);
	return id ? { ...raw, id } : undefined;
}

/** GET the model list — the one request that must succeed (unless the
 *  user named the models). Its failures become the user-facing reason the
 *  connection did not work. Lenient about the shape: OpenAI's {data: []},
 *  {models: []}, or a bare array. Anthropic-style lists are paginated (20
 *  by default) — ask for the maximum page. */
async function listModels(server: Pick<LocalServer, "baseUrl" | "api">, probe: Probe): Promise<Json[]> {
	const url =
		server.api === "anthropic-messages" ? `${server.baseUrl}/v1/models?limit=1000` : `${server.baseUrl}/models`;
	let res: Response;
	try {
		res = await probe.fetch(url, { headers: probe.headers, signal: probe.signal });
	} catch {
		if (probe.signal.aborted) throw new LocalServerError(`${url} did not answer in time`, "unreachable");
		throw new LocalServerError(`Could not reach ${url} — is the server running?`, "unreachable");
	}
	if (res.status === 401 || res.status === 403) {
		throw new LocalServerError(`The server refused the request (HTTP ${res.status}) — check the API key`, "auth");
	}
	const hint = "check the address and API type, or enter the model IDs yourself";
	if (!res.ok) throw new LocalServerError(`No model list at ${url} (HTTP ${res.status}) — ${hint}`, "no-list");
	const body: unknown = await res.json().catch(() => undefined);
	// An OpenAI-style list object with nothing in it may say data: null
	// (Ollama with no model pulled) — an empty list, not a missing one.
	const list = Array.isArray(body)
		? body
		: isRecord(body) && Array.isArray(body.data)
			? body.data
			: isRecord(body) && Array.isArray(body.models)
				? body.models
				: isRecord(body) && body.object === "list" && body.data === null
					? []
					: undefined;
	if (!list) throw new LocalServerError(`${url} did not return a model list — ${hint}`, "no-list");
	return list.map(listEntry).filter((e): e is Json => e !== undefined);
}

/** The context length a /v1/models entry carries, under any of the names
 *  servers use for it. */
function listedContext(entry: Json): number | undefined {
	const meta = isRecord(entry.meta) ? entry.meta : undefined;
	return firstPositiveInt(
		entry.max_model_len,
		entry.context_length,
		entry.context_window,
		entry.max_context_length,
		meta?.n_ctx,
		meta?.n_ctx_train,
	);
}

function listedName(entry: Json): string | undefined {
	const name = entry.display_name ?? entry.name;
	return typeof name === "string" && name.trim() ? name : undefined;
}

/** `owned_by` values that name nobody in particular. */
const GENERIC_OWNERS = new Set(["system", "user", "owner", "organization_owner", "library", "openai", "local", "unknown"]);

function listedOwner(entries: Json[]): string | undefined {
	const owners = new Set(entries.map((e) => (typeof e.owned_by === "string" ? e.owned_by.trim() : "")));
	const [owner] = owners;
	return owners.size === 1 && owner && !GENERIC_OWNERS.has(owner.toLowerCase()) ? owner : undefined;
}

function fromListing(engine: LocalEngine | null, entries: Json[]): LocalDiscovery {
	const owner = engine ? undefined : listedOwner(entries);
	return {
		engine,
		...(owner ? { owner } : {}),
		models: entries.map((e) => ({ id: e.id as string, name: listedName(e), contextWindow: listedContext(e) })),
		hidden: [],
	};
}

async function fromLlamaCpp(root: string, entries: Json[], probe: Probe): Promise<LocalDiscovery> {
	// Router mode serves several models — ask /props about each by name; a
	// single-model server ignores the query.
	const props = await Promise.all(
		entries.map((e) =>
			tryJson(probe, entries.length > 1 ? `${root}/props?model=${encodeURIComponent(e.id as string)}` : `${root}/props`),
		),
	);
	return {
		engine: "llamacpp",
		models: entries.map((e, i) => {
			const p = props[i];
			const runtime = isRecord(p?.default_generation_settings) ? p.default_generation_settings : undefined;
			const modalities = isRecord(p?.modalities) ? p.modalities : undefined;
			return {
				id: e.id as string,
				name: listedName(e),
				contextWindow: firstPositiveInt(runtime?.n_ctx, listedContext(e)),
				vision: typeof modalities?.vision === "boolean" ? modalities.vision : undefined,
			};
		}),
		hidden: [],
	};
}

/** Ollama's Modelfile parameters arrive as one text block ("num_ctx 8192"). */
function ollamaNumCtx(parameters: unknown): number | undefined {
	if (typeof parameters !== "string") return undefined;
	return firstPositiveInt(parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1]);
}

/** The trained length from Ollama's GGUF metadata ("<arch>.context_length"). */
function ollamaTrainedContext(modelInfo: unknown): number | undefined {
	if (!isRecord(modelInfo)) return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith(".context_length")) return firstPositiveInt(value);
	}
	return undefined;
}

async function fromOllama(root: string, entries: Json[], probe: Probe): Promise<LocalDiscovery> {
	// A loaded model reports the context it actually runs with — the best
	// truth; else the Modelfile's num_ctx; else the trained length.
	const ps = await tryJson(probe, `${root}/api/ps`);
	const running = new Map<string, number>();
	for (const m of Array.isArray(ps?.models) ? ps.models : []) {
		const ctx = isRecord(m) ? firstPositiveInt(m.context_length) : undefined;
		if (isRecord(m) && typeof m.name === "string" && ctx) running.set(m.name, ctx);
	}
	const shows = await Promise.all(entries.map((e) => tryJson(probe, `${root}/api/show`, { model: e.id })));
	const discovery: LocalDiscovery = { engine: "ollama", models: [], hidden: [] };
	entries.forEach((e, i) => {
		const id = e.id as string;
		const show = shows[i];
		const caps = Array.isArray(show?.capabilities)
			? show.capabilities.filter((c): c is string => typeof c === "string")
			: undefined;
		// Older Ollama builds report no capabilities — then nothing is hidden.
		if (caps && !caps.includes("completion")) {
			discovery.hidden.push({ id, reason: "embedding model" });
			return;
		}
		if (caps && !caps.includes("tools")) {
			discovery.hidden.push({ id, reason: "no tool calling" });
			return;
		}
		discovery.models.push({
			id,
			contextWindow: firstPositiveInt(running.get(id), ollamaNumCtx(show?.parameters), ollamaTrainedContext(show?.model_info)),
			vision: caps ? caps.includes("vision") : undefined,
			reasoning: caps ? caps.includes("thinking") : undefined,
		});
	});
	return discovery;
}

function fromLmStudio(entries: Json[], native: unknown[]): LocalDiscovery {
	const byId = new Map<string, Json>();
	for (const d of native) if (isRecord(d) && typeof d.id === "string") byId.set(d.id, d);
	const discovery: LocalDiscovery = { engine: "lmstudio", models: [], hidden: [] };
	for (const e of entries) {
		const id = e.id as string;
		const d = byId.get(id);
		if (d?.type === "embeddings") {
			discovery.hidden.push({ id, reason: "embedding model" });
			continue;
		}
		discovery.models.push({
			id,
			name: listedName(e),
			contextWindow: firstPositiveInt(d?.loaded_context_length, d?.max_context_length, listedContext(e)),
			vision: d ? d.type === "vlm" : undefined,
		});
	}
	return discovery;
}

/** Which engine served the list, and what its own endpoints add. ANY
 *  compatible server works without this — an unrecognized one is read
 *  from its list alone (context fields where present, the overrides and
 *  defaults elsewhere). */
async function describe(root: string, entries: Json[], probe: Probe): Promise<LocalDiscovery> {
	// The engines that sign their /v1/models entries need no probing.
	const owners = new Set(entries.map((e) => e.owned_by));
	if (owners.has("llamacpp")) return fromLlamaCpp(root, entries, probe);
	if (owners.has("vllm")) return fromListing("vllm", entries);
	if (owners.has("sglang")) return fromListing("sglang", entries);
	const version = await tryJson(probe, `${root}/api/version`);
	if (typeof version?.version === "string") return fromOllama(root, entries, probe);
	const lmstudio = await tryJson(probe, `${root}/api/v0/models`);
	if (Array.isArray(lmstudio?.data)) return fromLmStudio(entries, lmstudio.data);
	return fromListing(null, entries);
}

/**
 * Ask one server for its models. Throws LocalServerError (user-facing
 * message) when the model list cannot be read — unless the user NAMED
 * models (`server.models`), in which case a server without a list is fine
 * and its named models are offered as-is. Named models are always added
 * to what the server lists, even ones it would hide (the user's call).
 * Every metadata probe is best-effort. `fetch` is injectable for tests.
 */
export async function discoverLocalModels(
	server: Pick<LocalServer, "baseUrl" | "api" | "models">,
	options: { apiKey?: string; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<LocalDiscovery> {
	const probe: Probe = {
		fetch: options.fetch ?? fetch,
		signal: options.signal ?? AbortSignal.timeout(LOCAL_DISCOVERY_TIMEOUT_MS),
		headers: authHeaders(server.api, options.apiKey),
	};
	const named = server.models ?? [];
	let entries: Json[];
	try {
		entries = await listModels(server, probe);
	} catch (err) {
		if (!(err instanceof LocalServerError && err.code === "no-list" && named.length > 0)) throw err;
		entries = [];
	}
	const discovery = entries.length ? await describe(serverRoot(server.baseUrl), entries, probe) : fromListing(null, []);
	for (const id of named) {
		if (discovery.models.some((m) => m.id === id)) continue;
		discovery.hidden = discovery.hidden.filter((h) => h.id !== id);
		discovery.models.push({ id });
	}
	return discovery;
}

// ─── The pi provider ─────────────────────────────────────────────────────────

/** Request-shape settings for local engines (pi-ai README, "OpenAI
 *  Compatibility Settings"): Ollama, vLLM, llama.cpp and friends know no
 *  `developer` role (the system prompt goes out as `system`), no `store`
 *  field, and the classic `max_tokens`; no local engine keeps a prompt
 *  cache across the long-retention knobs or understands Anthropic's
 *  newest tool-streaming fields. */
const LOCAL_COMPAT: Record<LocalServerApi, Record<string, unknown>> = {
	"openai-completions": { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
	"openai-responses": { supportsDeveloperRole: false, supportsLongCacheRetention: false },
	"anthropic-messages": {
		supportsEagerToolInputStreaming: false,
		supportsLongCacheRetention: false,
		supportsCacheControlOnTools: false,
	},
};

const LOCAL_API_IMPLS: Record<LocalServerApi, () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
};

/** One discovered model as pi runs it: the server's report under the
 *  user's per-server overrides. Local inference is free (cost 0). No engine
 *  reports an output cap apart from the window, so maxTokens IS the window
 *  — pi clamps every request's max_tokens to what the prompt leaves. */
export function buildLocalModel(server: LocalServer, discovered: DiscoveredModel): Model<Api> {
	const contextWindow = server.contextWindow ?? discovered.contextWindow ?? LOCAL_DEFAULT_CONTEXT_WINDOW;
	const vision = server.vision ?? discovered.vision ?? false;
	return {
		id: discovered.id,
		name: discovered.name ?? discovered.id,
		api: server.api,
		provider: server.id,
		baseUrl: server.baseUrl,
		reasoning: discovered.reasoning ?? false,
		input: vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: LOCAL_COMPAT[server.api],
	} as Model<Api>;
}

/** The pi provider for one server. Auth is always "configured": a stored
 *  key rides the env seam (auth.json → process.env, src/server/keys.ts)
 *  under `keyEnvVar`; without one the keyless placeholder goes out. */
export function localProvider(server: LocalServer, models: readonly DiscoveredModel[], keyEnvVar: string): Provider {
	return createProvider({
		id: server.id,
		name: server.name,
		baseUrl: server.baseUrl,
		auth: {
			apiKey: {
				name: `${server.name} API key`,
				resolve: async ({ ctx }) => {
					const key = await ctx.env(keyEnvVar);
					return key
						? { auth: { apiKey: key }, source: keyEnvVar }
						: { auth: { apiKey: KEYLESS_API_KEY }, source: "keyless local server" };
				},
			},
		},
		models: models.map((m) => buildLocalModel(server, m)),
		api: LOCAL_API_IMPLS[server.api](),
	});
}

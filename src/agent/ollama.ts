/**
 * The Ollama provider (local-models wave, owner 2026-10-25): one Ollama
 * server — local, or anything speaking its API — federated into the same
 * pi-ai Models collection as the builtin providers. pi-ai ships no Ollama
 * catalog; this module builds the provider with createProvider() over the
 * OpenAI-compatible endpoint ({url}/v1) and a DYNAMIC model list read from
 * Ollama's native /api/tags (+ /api/show when tags lacks the facts).
 *
 * Configuration rides the env seam like every key (src/server/keys.ts
 * reflects auth.json into process.env): OLLAMA_BASE_URL switches the
 * provider on, OLLAMA_API_KEY is optional (cloud endpoints; local Ollama
 * ignores the bearer). Cloud models run through a signed-in local daemon
 * ("gemma4:31b-cloud") list like any other model.
 *
 * Owner rulings: only models that report the `tools` capability list (the
 * teacher cannot run without tool calls), and only models whose REPORTED
 * context length is at least the compaction floor — no fabricated
 * fallback window, a model without one is simply not listed.
 */

import { createProvider, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OLLAMA_KEY_VAR, OLLAMA_URL_VAR } from "../core/auth-keys.ts";
import { COMPACTION_THRESHOLD_FLOOR } from "../core/settings.ts";

export const OLLAMA_PROVIDER = "ollama";

/** One /api/tags (or /api/show) answer, reduced to what we read. */
export interface OllamaModelFacts {
	name: string;
	capabilities?: readonly string[];
	contextLength?: number;
}

/** The base URL as configured (normalized on write), or undefined = off. */
export function ollamaBaseUrl(): string | undefined {
	return process.env[OLLAMA_URL_VAR] || undefined;
}

function ollamaApiKey(): string | undefined {
	return process.env[OLLAMA_KEY_VAR] || undefined;
}

/** Ollama's reasoning_effort values (verified against Ollama 0.31's
 *  OpenAI-compatible endpoint: "none" turns thinking off). */
const THINKING_LEVEL_MAP = { off: "none", minimal: null, low: "low", medium: "medium", high: "high" } as const;

/** Pure: one model's facts → a pi model, or null when the owner's listing
 *  rules exclude it (no tool calls, or no/too-small reported context). */
export function ollamaModel(baseUrl: string, facts: OllamaModelFacts): Model<"openai-completions"> | null {
	const capabilities = facts.capabilities ?? [];
	if (!capabilities.includes("tools")) return null;
	const contextWindow = facts.contextLength;
	if (!contextWindow || contextWindow < COMPACTION_THRESHOLD_FLOOR) return null;
	const reasoning = capabilities.includes("thinking");
	return {
		id: facts.name,
		name: facts.name,
		api: "openai-completions",
		provider: OLLAMA_PROVIDER,
		baseUrl: `${baseUrl}/v1`,
		reasoning,
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		// Ollama reports no output cap (its num_predict default is unlimited
		// up to the context), so the window is the honest ceiling; pi clamps
		// each request to the room the prompt leaves.
		maxTokens: contextWindow,
		...(reasoning ? { thinkingLevelMap: THINKING_LEVEL_MAP } : {}),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	};
}

/** The context length out of /api/show's model_info ("<arch>.context_length"). */
export function showContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
	for (const [key, value] of Object.entries(modelInfo ?? {})) {
		if (key.endsWith(".context_length") && typeof value === "number") return value;
	}
	return undefined;
}

/** Bounded per call so a down or unreachable server never hangs the picker. */
const REQUEST_TIMEOUT_MS = 5000;

async function ollamaJson<T>(baseUrl: string, path: string, signal: AbortSignal, body?: unknown): Promise<T> {
	const key = ollamaApiKey();
	const res = await fetch(`${baseUrl}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!res.ok) throw new Error(`Ollama ${path} answered ${res.status}`);
	return (await res.json()) as T;
}

interface TagsBody {
	models?: { name?: string; capabilities?: string[]; details?: { context_length?: number } }[];
}
interface ShowBody {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
}

/** The server's usable models: /api/tags first (Ollama ≥ 0.31 reports
 *  capabilities + context there), /api/show only for entries that lack
 *  either fact (older servers). */
export async function fetchOllamaModels(baseUrl: string, signal: AbortSignal): Promise<Model<"openai-completions">[]> {
	const tags = await ollamaJson<TagsBody>(baseUrl, "/api/tags", signal);
	const facts = await Promise.all(
		(tags.models ?? []).flatMap((tag) => {
			const name = tag.name;
			if (!name) return [];
			const known: OllamaModelFacts = { name, capabilities: tag.capabilities, contextLength: tag.details?.context_length };
			if (known.capabilities && known.contextLength) return [Promise.resolve(known)];
			return [
				ollamaJson<ShowBody>(baseUrl, "/api/show", signal, { model: name })
					.then((show) => ({
						name,
						capabilities: known.capabilities ?? show.capabilities,
						contextLength: known.contextLength ?? showContextLength(show.model_info),
					}))
					.catch(() => known),
			];
		}),
	);
	return facts
		.map((f) => ollamaModel(baseUrl, f))
		.filter((m): m is Model<"openai-completions"> => m !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** The provider for one base URL. Auth resolves undefined (= unconfigured,
 *  pi skips it) when the URL is gone; a keyless server gets a placeholder
 *  bearer because pi's OpenAI client refuses an empty key. */
export function ollamaProvider(baseUrl: string): Provider<"openai-completions"> {
	return createProvider({
		id: OLLAMA_PROVIDER,
		name: "Ollama",
		baseUrl: `${baseUrl}/v1`,
		auth: {
			apiKey: {
				name: "Ollama",
				resolve: async () => (ollamaBaseUrl() ? { auth: { apiKey: ollamaApiKey() ?? "ollama" } } : undefined),
			},
		},
		models: [],
		fetchModels: ({ signal }) => fetchOllamaModels(baseUrl, signal),
		api: openAICompletionsApi(),
	});
}

// The URL the collection's ollama provider was built for — globalThis
// anchored like the collection's other process-wide state (HMR re-imports).
const SYNC_KEY = Symbol.for("lh.ollama.registeredUrl");
type SyncState = { url: string | undefined };
function syncState(): SyncState {
	const g = globalThis as Record<symbol, SyncState | undefined>;
	return (g[SYNC_KEY] ??= { url: undefined });
}

/** Keep the collection's ollama provider in step with the configured URL:
 *  registered (empty until refreshed) when set, replaced when it changes
 *  (a new server's models never mix with the old), removed when cleared.
 *  Cheap — an env read and a compare — so every piModels() call runs it. */
export function syncOllamaProvider(models: MutableModels): void {
	const state = syncState();
	const url = ollamaBaseUrl();
	if (url === state.url) return;
	state.url = url;
	if (url) models.setProvider(ollamaProvider(url));
	else models.deleteProvider(OLLAMA_PROVIDER);
}

/** Re-read the server's model list. Never throws: an unreachable server
 *  keeps the last-known list (pi's refresh reports, never rejects). */
export async function refreshOllamaModels(models: MutableModels): Promise<void> {
	syncOllamaProvider(models);
	if (!ollamaBaseUrl()) return;
	const result = await models.refresh({ providers: [OLLAMA_PROVIDER], force: true });
	const error = result.errors.get(OLLAMA_PROVIDER);
	if (error) console.warn(`[ollama] model list refresh failed: ${error.message}`);
}


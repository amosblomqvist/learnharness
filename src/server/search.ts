/** Server composition for keyed web search and the ChatGPT subscription adapter.
 *  Automatic prefers ChatGPT for an eligible ChatGPT researcher; otherwise
 *  keyed engines resolve Tavily before Brave. Explicit pins never fall back.
 *  The agent receives only the core search port. */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";
import { searchChatGPT } from "../agent/chatgpt-search.ts";
import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTModel } from "../agent/chatgpt-bridge.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** The engines this wave ships, in PREFERENCE order (both keys present,
 *  no explicit pin → the first live engine wins; owner decision
 *  2026-09-20: Tavily first — the AI-native search API the wave chose). */
const ENGINE_ORDER: ReadonlyArray<{ id: Exclude<SearchEngineId, "chatgpt">; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: Exclude<SearchEngineId, "chatgpt">): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Resolve explicit pins and Automatic preference from supplied metadata.
 *  ChatGPT readiness is independent of keyed-provider credentials. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<Exclude<SearchEngineId, "chatgpt">, string | undefined>>,
	chatgpt: { selected: boolean; ready: boolean; connected: boolean; backgroundAllowed: boolean } = { selected: false, ready: false, connected: false, backgroundAllowed: false },
): SearchStatus & { key: string | null } {
	const chatgptAvailable = chatgpt.selected && chatgpt.ready && chatgpt.connected && chatgpt.backgroundAllowed;
	if (pinned === "chatgpt" || (!pinned && chatgpt.selected)) return chatgptAvailable
		? { available: true, chatgptAvailable, engine: "chatgpt", reason: "ChatGPT web search is available", key: null }
		: { available: false, chatgptAvailable, engine: null, reason: "ChatGPT web search requires an eligible researcher model, a connected account, an available model catalog, and background permission", key: null };
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				chatgptAvailable,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${pinned === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY"} key`,
				key: null,
			};
		}
		return { available: true, chatgptAvailable, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id as Exclude<SearchEngineId, "chatgpt">] ?? null;
		if (key) return { available: true, chatgptAvailable, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		chatgptAvailable,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key",
		key: null,
	};
}

/** Resolve live search readiness from settings, key presence, and cached
 *  subscription/catalog metadata; performs no catalog or credential request. */
export function searchStatus(): SearchStatus {
	const settings = effectiveSettings();
	const researcher = settings.agent.models.researcher;
	const selected = researcher?.provider === "chatgpt";
	const modelId = selected ? researcher.id : "";
	const { available, chatgptAvailable, engine, reason } = resolveSearchEngineFor(
		settings.agent.search?.engine,
		{ tavily: engineKey("tavily") ?? undefined, brave: engineKey("brave") ?? undefined },
		{ selected, ready: !!modelId && !!chatGPTModel(modelId), connected: chatGPTConnected(), backgroundAllowed: chatGPTBackgroundAllowed() },
	);
	return { available, chatgptAvailable, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The live search adapter, or null while the selected search mode is unavailable. */
export function searchProvider(): SearchProvider | null {
	const settings = effectiveSettings();
	const researcher = settings.agent.models.researcher;
	const selected = researcher?.provider === "chatgpt";
	const modelId = selected ? researcher.id : "";
	const resolved = resolveSearchEngineFor(settings.agent.search?.engine, {
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	}, { selected, ready: !!modelId && !!chatGPTModel(modelId), connected: chatGPTConnected(), backgroundAllowed: chatGPTBackgroundAllowed() });
	if (!resolved.available) return null;
	if (resolved.engine === "chatgpt") return {
		id: "chatgpt",
		search: (query, count, signal) => searchChatGPT(query, count, modelId, signal),
	};
	if (!resolved.key) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}

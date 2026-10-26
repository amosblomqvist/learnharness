/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (TAVILY_API_KEY / BRAVE_API_KEY — curated catalog), and the server
 * composes the live adapter. The Google CSE engine retired with this wave
 * (closed to new customers; dies Jan 2027) — replaced by Tavily + Brave.
 *
 * Owner decisions baked here:
 *  - NO default engine in the factory record: an engine is live iff its
 *    key is present. With a key, the engine auto-activates (the user never
 *    chooses an engine to make search work — setting the key is enough);
 *    agent.search.engine is only an explicit preference.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so; the researcher sub-agent is disabled
 *    by the agent layer on the same signal — that rewiring is the Teacher
 *    stream's, on this port).
 *
 * Pure types + protocol docs only (browser-safe, no node imports): the
 * adapters are server-side (src/server/search.ts) and arrive as injected
 * dependencies — the agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The engine ids this wave ships (the catalog: curated keys + adapters). */
export const SEARCH_ENGINE_IDS = ["tavily", "brave", "chatgpt"] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** Candidate ChatGPT readiness is independent of the active preference. */
	chatgptAvailable: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}

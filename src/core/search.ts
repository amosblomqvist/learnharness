/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (the curated key catalog), and the server composes the live adapter.
 *
 * Owner decisions baked here:
 *  - NO default engine in the factory record: an engine is live iff its
 *    key is present. With a key, the engine auto-activates (the user never
 *    chooses an engine to make search work — setting the key is enough);
 *    agent.search.engine is only an explicit preference.
 *  - OpenAI web search has no key of its own: it runs on the researcher's
 *    OpenAI model and is used only when explicitly chosen.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so). Research remains available keylessly
 *    through web_fetch for known URLs.
 *
 * Pure types, the engine table + protocol docs only (browser-safe, no node
 * imports): the adapters are server-side (src/server/search.ts) and arrive
 * as injected dependencies — the agent-layer tool depends on THIS port only.
 */

import type { Usage } from "@earendil-works/pi-ai";

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Search engines in automatic preference order. Keep existing preferences
 * stable when adding an engine: an explicit pin always wins. An engine with
 * no envVar has no key and is never picked automatically. */
export const SEARCH_ENGINES = [
	{ id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", label: "Brave", envVar: "BRAVE_API_KEY" },
	{ id: "exa", label: "Exa", envVar: "EXA_API_KEY" },
	{ id: "firecrawl", label: "Firecrawl", envVar: "FIRECRAWL_API_KEY" },
	{ id: "ollama", label: "Ollama", envVar: "OLLAMA_API_KEY" },
	{ id: "openai", label: "OpenAI", envVar: null },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** The read/write guards' membership check (settings record + PUT body). */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return SEARCH_ENGINES.some((engine) => engine.id === value);
}

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	/** How long one search may run when the shared tool limit is too short:
	 *  set by an engine that searches through a whole model call. */
	timeoutMs?: number;
	search(query: string, count: number, context?: SearchContext): Promise<SearchHit[]>;
}

/** What the calling job lends one search. Only an engine that searches
 *  through a model call reads the job's model and reports usage. */
export interface SearchContext {
	signal?: AbortSignal;
	/** The model the job itself runs on, fixed for the job's lifetime. */
	model?: { provider: string; id: string };
	onUsage?: (usage: Usage) => void;
}

/** How a keyless engine stands for the current settings: usable, held back
 *  by something the user can fix, or not something this setup can run. */
export type EngineReadiness = "ready" | "blocked" | "unsupported";

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
	/** Keyless engines only: whether each could run right now. */
	keyless: Partial<Record<SearchEngineId, EngineReadiness>>;
}

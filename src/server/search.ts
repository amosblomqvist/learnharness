/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): search adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when several keys are
 *    present the order is Tavily → Brave → Exa → Firecrawl → Ollama → Parallel);
 *    without a pin, the first keyed engine wins.
 *  - An explicit choice does NOT silently fall back to another engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import { SEARCH_ENGINES, type SearchEngineId, type SearchHit, type SearchProvider, type SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

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
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
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
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
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

/** Invalid JSON must not echo provider response bodies into tool results. */
async function searchJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${label} search API returned an invalid response`);
	}
}

/** Exa's Search API returns highlights when requested. Its result snippets
 * are normalized to the same bounded, provider-neutral shape as the other
 * adapters. Do not expose error bodies, which may contain credentials. */
export function exaProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "exa",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.exa.ai/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify({ query, type: "auto", numResults: Math.min(100, Math.max(1, Math.floor(count))), contents: { highlights: true } }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Exa search API ${resp.status}`);
			const data = await searchJson(resp, "Exa");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Exa search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; highlights?: unknown; text?: unknown };
				if (typeof row.url !== "string" || !row.url.trim()) return [];
				try {
					const protocol = new URL(row.url).protocol;
					if (protocol !== "http:" && protocol !== "https:") return [];
				} catch { return []; }
				const highlights = Array.isArray(row.highlights) ? row.highlights.filter((v): v is string => typeof v === "string").join(" ") : "";
				const snippet = highlights || (typeof row.text === "string" ? row.text : "");
				return [{ title: typeof row.title === "string" && row.title ? row.title : row.url, url: row.url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500) }];
			});
		},
	};
}

/** Firecrawl's v2 search API: no scrapeOptions, so web_fetch still owns
 *  page bodies. Wire shape checked against the official 2026-11-03 snapshot;
 *  live account access and pricing are not inferred from configuration. */
export function firecrawlProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "firecrawl",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.firecrawl.dev/v2/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, limit: Math.min(100, Math.max(1, Math.floor(count))) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Firecrawl search API ${resp.status}`);
			const data = await searchJson(resp, "Firecrawl");
			if (!data || typeof data !== "object" || (data as { success?: unknown }).success !== true) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			const payload = (data as { data?: unknown }).data;
			if (!payload || typeof payload !== "object" || !Array.isArray((payload as { web?: unknown }).web)) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			return (payload as { web: unknown[] }).web.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; description?: unknown };
				return searchHit(row.title, row.url, row.description);
			});
		},
	};
}

/** Hosted search only, adapted from chiranjivsethi's PR #81 (a216fa8).
 *  No local model URL, model registration, or provider-backed page fetch. */
export function ollamaProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "ollama",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://ollama.com/api/web_search", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ query, max_results: Math.min(10, Math.max(1, Math.floor(count))) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Ollama search API ${resp.status}`);
			const data = await searchJson(resp, "Ollama");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Ollama search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; content?: unknown };
				return searchHit(row.title, row.url, row.content);
			});
		},
	};
}

/** Parallel (parallel.ai) Search API.
 *  VERIFIED against a live call 2026-11-08: POST https://api.parallel.ai/v1/search
 *  with the key in `x-api-key`; body {search_queries: string[], objective?,
 *  mode?, max_chars_total?}; response
 *  {search_id, results: [{url, title, publish_date, excerpts: string[]}]}.
 *
 *  Two shape differences from the other engines, both absorbed here:
 *  - there is no result-count parameter (max_chars_total bounds the excerpts,
 *    not the rows), so `count` slices the list after the fact;
 *  - a search is a set of short keyword queries plus an optional objective, so
 *    the researcher's one free-text query rides as both (their docs ask for
 *    "3-6 words each" — a longer sentence still works, and the objective is
 *    what actually steers relevance). */
export function parallelProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "parallel",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const limit = Math.min(20, Math.max(1, Math.floor(count)));
			const resp = await fetchFn("https://api.parallel.ai/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify({
					search_queries: [query],
					objective: query,
					// Bound the payload the way the port expects: our snippets cap
					// at 500 chars each, so nothing above that is worth paying for.
					max_chars_total: Math.min(8000, limit * 500),
				}),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Parallel search API ${resp.status}`);
			const data = await searchJson(resp, "Parallel");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Parallel search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; excerpts?: unknown };
				const excerpts = Array.isArray(row.excerpts)
					? row.excerpts.filter((v): v is string => typeof v === "string").join(" ")
					: "";
				return searchHit(row.title, row.url, excerpts);
			}).slice(0, limit);
		},
	};
}

/** Match Exa's bounded result contract for the other new adapters. */
function searchHit(title: unknown, url: unknown, snippet: unknown): SearchHit[] {
	if (typeof url !== "string" || !url.trim()) return [];
	try {
		const protocol = new URL(url).protocol;
		if (protocol !== "http:" && protocol !== "https:") return [];
	} catch { return []; }
	return [{
		title: typeof title === "string" && title ? title : url,
		url,
		snippet: typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim().slice(0, 500) : "",
	}];
}

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Every engine's live key, read fresh (the resolver's input). */
function engineKeys(): Partial<Record<SearchEngineId, string>> {
	const keys: Partial<Record<SearchEngineId, string>> = {};
	for (const { id } of SEARCH_ENGINES) {
		const key = engineKey(id);
		if (key) keys[id] = key;
	}
	return keys;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${SEARCH_ENGINES.find((e) => e.id === pinned)?.envVar} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of SEARCH_ENGINES) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily, Brave, Exa, Firecrawl, Ollama, or Parallel search API key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		engineKeys(),
	);
	return { available, engine, reason };
}

/** Search status only — research itself remains available without a key. */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	switch (resolved.engine) {
		case "tavily":
			return tavilyProvider(resolved.key);
		case "brave":
			return braveProvider(resolved.key);
		case "exa":
			return exaProvider(resolved.key);
		case "firecrawl":
			return firecrawlProvider(resolved.key);
		case "ollama":
			return ollamaProvider(resolved.key);
		case "parallel":
			return parallelProvider(resolved.key);
		default:
			return null;
	}
}

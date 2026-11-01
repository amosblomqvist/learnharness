/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import { parseHTML } from "linkedom";
import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** DuckDuckGo: GET https://html.duckduckgo.com/html/?q=<query> — public
 *  HTML endpoint, NO API key, scraping with linkedom. Parses .result
 *  elements: .result__a for title+url, .result__snippet for snippet.
 *  Sets a proper User-Agent so DDG doesn't block the request. */
export function duckduckgoProvider(
	apiKey: string,
	fetchFn: FetchLike = fetch,
): SearchProvider {
	return {
		id: "duckduckgo",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://html.duckduckgo.com/html/");
			url.searchParams.set("q", query);
			const resp = await fetchFn(url.toString(), {
				headers: {
					"user-agent":
						"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				throw new Error(`DuckDuckGo ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
			}
			const html = await resp.text();
			const { document } = await parseHTML(html);
			const hits: SearchHit[] = [];
			for (const result of document.querySelectorAll(".result")) {
				const link = result.querySelector<HTMLElement>(".result__a");
				const snippet = result.querySelector<HTMLElement>(".result__snippet");
				if (!link) continue;
				const url = link.getAttribute("href") ?? "";
				if (!url) continue;
				hits.push({
					title: link.textContent?.trim() ?? "",
					url,
					snippet: (snippet?.textContent ?? "").replace(/\n/g, " ").trim().slice(0, 500),
				});
				if (hits.length >= count) break;
			}
			return hits;
		},
	};
}

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

/** The engines this wave ships, in PREFERENCE order (both keys present,
 *  no explicit pin → the first live engine wins; owner decision
 *  2026-09-20: Tavily first — the AI-native search API the wave chose). */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar: string | null }> = [
	{ id: "duckduckgo", envVar: null },
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. DuckDuckGo needs no
 *  key (envVar null) so it always returns a non-null sentinel — always
 *  live, always available. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	if (!envVar) return id;
	const value = keyValue(envVar);
	return value ? value : null;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	// DuckDuckGo needs no key — it is always live and always available.
	const keyFor = (id: SearchEngineId): string | null =>
		id === "duckduckgo" ? id : (keys[id] ?? null);

	const keyedEngines: SearchEngineId[] = [];
	for (const { id } of ENGINE_ORDER) {
		if (keyFor(id)) keyedEngines.push(id);
	}

	if (pinned) {
		const pinnedKey = keyFor(pinned);
		if (!pinnedKey) {
			const varName = pinned === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${varName} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}

	// No pin: first keyed engine in preference order wins. DuckDuckGo is
	// always keyed, so it is the live engine whenever nothing is pinned.
	const id = keyedEngines[0];
	return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key: keys[id] ?? null };
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			duckduckgo: engineKey("duckduckgo") ?? undefined,
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
	);
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, {
		duckduckgo: engineKey("duckduckgo") ?? undefined,
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	});
	if (!resolved.available || !resolved.key) return null;
	switch (resolved.engine) {
		case "duckduckgo":
			return duckduckgoProvider(resolved.key);
		case "tavily":
			return tavilyProvider(resolved.key);
		default:
			return braveProvider(resolved.key);
	}
}

/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the search adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, exaProvider, firecrawlProvider, ollamaProvider, parallelProvider } from "../src/server/search.ts";
import { SEARCH_ENGINES, isSearchEngineId, type SearchEngineId } from "../src/core/search.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");

		const fc = resolveSearchEngineFor(undefined, { firecrawl: "fc-throwaway-key-000001" });
		assert.ok(fc.available);
		assert.equal(fc.engine, "firecrawl");
		assert.match(fc.reason, /auto/);
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("Tavily and Brave keep their priority over Firecrawl", () => {
		const all = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
			firecrawl: "fc-throwaway-key-000001",
		});
		assert.equal(all.engine, "tavily");
		const braveAndFc = resolveSearchEngineFor(undefined, {
			brave: "brave-throwaway-key-00001",
			firecrawl: "fc-throwaway-key-000001",
		});
		assert.equal(braveAndFc.engine, "brave");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});

	it("auto-detects an Exa key, preserving existing engine priority", () => {
		assert.equal(resolveSearchEngineFor(undefined, { exa: "exa-test-key" }).engine, "exa");
		assert.equal(resolveSearchEngineFor(undefined, { exa: "exa-test-key", brave: "brave-key" }).engine, "brave");
		assert.equal(resolveSearchEngineFor(undefined, { exa: "exa-test-key", brave: "brave-key", tavily: "tavily-key" }).engine, "tavily");
	});

	it("honors an Exa pin and refuses to silently fall back", () => {
		assert.equal(resolveSearchEngineFor("exa", { exa: "exa-test-key", tavily: "tavily-key" }).engine, "exa");
		const missing = resolveSearchEngineFor("exa", { tavily: "tavily-key" });
		assert.equal(missing.available, false);
		assert.match(missing.reason, /EXA_API_KEY/);
	});

	it("a Firecrawl pin without its key names FIRECRAWL_API_KEY", () => {
		const out = resolveSearchEngineFor("firecrawl", { tavily: "tvly-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /FIRECRAWL_API_KEY/);

		const pinned = resolveSearchEngineFor("firecrawl", {
			tavily: "tvly-throwaway-key-00001",
			firecrawl: "fc-throwaway-key-000001",
		});
		assert.equal(pinned.engine, "firecrawl");
		assert.match(pinned.reason, /chosen/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});

describe("exaProvider", () => {
	it("sends the documented request and maps bounded highlights to search hits", async () => {
		const provider = exaProvider("exa-secret-test-key", stubFetch({ results: [
			{ title: "Example", url: "https://example.com/a", highlights: ["first\nline", "second"] },
			{ url: "https://example.com/b", highlights: [], text: "x".repeat(600) },
			{ title: "Missing URL" }, { url: "javascript:alert(1)" }, null,
		] }, (url, init) => {
			assert.equal(url, "https://api.exa.ai/search");
			assert.equal(init.method, "POST");
			assert.equal((init.headers as Record<string, string>)["x-api-key"], "exa-secret-test-key");
			assert.deepEqual(JSON.parse(init.body as string), { query: "test query", type: "auto", numResults: 5, contents: { highlights: true } });
			assert.ok(init.signal);
		}));
		assert.deepEqual(await provider.search("test query", 5), [
			{ title: "Example", url: "https://example.com/a", snippet: "first line second" },
			{ title: "https://example.com/b", url: "https://example.com/b", snippet: "x".repeat(500) },
		]);
	});

	it("clamps counts to Exa's range", async () => {
		const counts: number[] = [];
		const provider = exaProvider("key", stubFetch({ results: [] }, (_url, init) => counts.push(JSON.parse(init.body as string).numResults)));
		await provider.search("q", 0);
		await provider.search("q", 200);
		assert.deepEqual(counts, [1, 100]);
	});

	it("reports HTTP and malformed-response failures without exposing the key", async () => {
		const key = "exa-secret-test-key";
		const denied = exaProvider(key, async () => new Response(`bad ${key}`, { status: 429 }));
		await assert.rejects(denied.search("q", 5), (error: Error) => /Exa search API 429/.test(error.message) && !error.message.includes(key));
		const malformed = exaProvider(key, async () => new Response(JSON.stringify({ results: null }), { status: 200 }));
		await assert.rejects(malformed.search("q", 5), /invalid response/);
	});
});

describe("firecrawlProvider (wire shape per docs.firecrawl.dev, verified 2026-10-29)", () => {
	it("POSTs api.firecrawl.dev/v2/search with Bearer auth + query/limit, no scrape", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", stubFetch(
			{
				success: true,
				data: {
					web: [
						{ title: "Example", url: "https://example.com/c", description: "line1\nline2", position: 1 },
						{ url: "https://example.com/untitled", description: "no title" },
						{ title: "No URL", description: "dropped" },
					],
				},
			},
			(url, init) => {
				assert.equal(url, "https://api.firecrawl.dev/v2/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer fc-throwaway-key-000001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.limit, 5);
				// A bare search — scraping each hit would cost extra credits.
				assert.equal(body.scrapeOptions, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [
			{ title: "Example", url: "https://example.com/c", snippet: "line1 line2" },
			{ title: "https://example.com/untitled", url: "https://example.com/untitled", snippet: "no title" },
		]);
	});

	it("reports HTTP status without exposing the provider error body", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", async () =>
			new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid token" }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Firecrawl search API 401$/);
	});

	it("reports HTTP status without exposing a non-JSON error body", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", async () =>
			new Response("Payment Required", { status: 402 }),
		);
		await assert.rejects(provider.search("q", 5), /Firecrawl search API 402$/);
	});
});

// Search-only subset of chiranjivsethi's PR #81, source commit a216fa8.
// No fetchPage, local model server, or model pricing is part of this adapter.
describe("ollamaProvider (hosted search only)", () => {
	it("POSTs ollama.com/api/web_search with Bearer auth and bounded snippets", async () => {
		const provider = ollamaProvider("ollama-fake-key-123456", stubFetch({ results: [
			{ title: "Ollama", url: "https://ollama.com", content: "line1\nline2" },
			{ url: "https://example.org", content: "x".repeat(600) },
			{ content: "no URL" }, { url: "javascript:alert(1)" }, null,
		] }, (url, init) => {
			assert.equal(url, "https://ollama.com/api/web_search");
			assert.equal(init.method, "POST");
			assert.equal((init.headers as Record<string, string>).authorization, "Bearer ollama-fake-key-123456");
			assert.deepEqual(JSON.parse(init.body as string), { query: "test query", max_results: 5 });
			assert.ok(init.signal);
		}));
		assert.deepEqual(await provider.search("test query", 5), [
			{ title: "Ollama", url: "https://ollama.com", snippet: "line1 line2" },
			{ title: "https://example.org", url: "https://example.org", snippet: "x".repeat(500) },
		]);
		assert.equal("fetchPage" in provider, false);
	});
});

// The wire shape below was verified against a live api.parallel.ai call on
// 2026-11-08 — endpoint, x-api-key header, request body keys and the
// results/excerpts response.
describe("parallelProvider", () => {
	it("POSTs api.parallel.ai/v1/search with x-api-key and normalizes excerpts", async () => {
		const provider = parallelProvider("parallel-fake-key-123456", stubFetch({ results: [
			{ title: "Pythagoras", url: "https://example.com/p", excerpts: ["first part", "second part"] },
			{ url: "https://example.org/q", excerpts: ["x".repeat(600)] },
			{ url: "file:///etc/passwd", excerpts: ["nope"] },
			{ title: "no excerpts", url: "https://example.net/r" },
			null,
		] }, (url, init) => {
			assert.equal(url, "https://api.parallel.ai/v1/search");
			assert.equal(init.method, "POST");
			assert.equal((init.headers as Record<string, string>)["x-api-key"], "parallel-fake-key-123456");
			assert.deepEqual(JSON.parse(init.body as string), {
				search_queries: ["test query"],
				objective: "test query",
				max_chars_total: 2500,
			});
			assert.ok(init.signal);
		}));
		assert.deepEqual(await provider.search("test query", 5), [
			{ title: "Pythagoras", url: "https://example.com/p", snippet: "first part second part" },
			{ title: "https://example.org/q", url: "https://example.org/q", snippet: "x".repeat(500) },
			{ title: "no excerpts", url: "https://example.net/r", snippet: "" },
		]);
	});

	it("slices to the requested count — the API has no result-count parameter", async () => {
		const rows = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, excerpts: [`e${i}`] }));
		const provider = parallelProvider("parallel-fake-key-123456", stubFetch({ results: rows }, () => {}));
		assert.equal((await provider.search("q", 3)).length, 3);
	});

	it("refuses a malformed response instead of returning empty results", async () => {
		const provider = parallelProvider("parallel-fake-key-123456", stubFetch({ results: "not a list" }, () => {}));
		await assert.rejects(() => provider.search("q", 5), /invalid response/);
	});
});

describe("six-engine catalog and resolution", () => {
	it("pins the approved Automatic order independently of table-driven tests", () => {
		assert.deepEqual(SEARCH_ENGINES.map(({ id }) => id), ["tavily", "brave", "exa", "firecrawl", "ollama", "parallel"]);
		assert.equal(isSearchEngineId("chatgpt"), false);
		assert.equal(isSearchEngineId("deepseek"), false);
		for (const value of [null, {}, 1, "", "toString"]) assert.equal(isSearchEngineId(value), false);
	});

	it("resolves every combination of configured keys without changing precedence", () => {
		for (let mask = 0; mask < 2 ** SEARCH_ENGINES.length; mask++) {
			const configured = SEARCH_ENGINES.filter((_, index) => mask & (1 << index));
			const keys = Object.fromEntries(configured.map(({ id }) => [id, `fake-${id}`]));
			const result = resolveSearchEngineFor(undefined, keys);
			assert.equal(result.engine, configured[0]?.id ?? null, `key mask ${mask}`);
			assert.equal(result.available, configured.length > 0);
		}
	});

	for (const { id, envVar } of SEARCH_ENGINES) {
		it(`${id}: an explicit pin wins, but a missing pinned key never falls back`, () => {
			const keys: Partial<Record<SearchEngineId, string>> = Object.fromEntries(SEARCH_ENGINES.map(({ id }) => [id, `fake-${id}`]));
			assert.equal(resolveSearchEngineFor(id, keys).engine, id);
			delete keys[id];
			const missing = resolveSearchEngineFor(id, keys);
			assert.equal(missing.available, false);
			assert.equal(missing.engine, null);
			assert.ok(missing.reason.includes(envVar));
		});
	}
});

const NEW_ADAPTERS = [
	{ label: "Exa", create: exaProvider, body: { results: [] }, field: "numResults", max: 100 },
	{ label: "Firecrawl", create: firecrawlProvider, body: { success: true, data: { web: [] } }, field: "limit", max: 100 },
	{ label: "Ollama", create: ollamaProvider, body: { results: [] }, field: "max_results", max: 10 },
] as const;

for (const { label, create, body, field, max } of NEW_ADAPTERS) {
	describe(`${label}: search adapter failure/shape contract`, () => {
		it("returns an empty result array for a successful empty search", async () => {
			assert.deepEqual(await create("fake-key", stubFetch(body, () => {})).search("q", 5), []);
		});
		it("sends integer counts within the provider range", async () => {
			const counts: number[] = [];
			const provider = create("fake-key", stubFetch(body, (_url, init) => counts.push(JSON.parse(init.body as string)[field])));
			for (const count of [1, 5, 10, 200, 0, 2.8]) await provider.search("q", count);
			assert.deepEqual(counts, [1, 5, 10, max, 1, 2]);
		});
		it("rejects malformed envelopes and invalid JSON without echoing bodies", async () => {
			for (const invalid of [null, {}, [], { results: null }, { success: false, error: "fake-secret-123456" }]) {
				const provider = create("fake-secret-123456", async () => new Response(JSON.stringify(invalid)));
				await assert.rejects(provider.search("q", 5), { message: `${label} search API returned an invalid response` });
			}
			const provider = create("fake-secret-123456", async () => new Response("invalid fake-secret-123456"));
			await assert.rejects(provider.search("q", 5), { message: `${label} search API returned an invalid response` });
		});
		it("reports auth, quota, rate-limit and server failures without response bodies or retries", async () => {
			for (const status of [401, 402, 429, 500]) {
				let calls = 0;
				const provider = create("fake-secret-123456", async () => {
					calls++;
					return new Response("fake-secret-123456", { status });
				});
				await assert.rejects(provider.search("q", 5), { message: `${label} search API ${status}` });
				assert.equal(calls, 1);
			}
		});
	});
}

it("Firecrawl drops invalid result rows and normalizes only search descriptions", async () => {
	const provider = firecrawlProvider("fc-fake-key-123456789", stubFetch({ success: true, data: { web: [
		null, 1, { url: "file:///tmp/private" }, { url: "not a URL" },
		{ title: 42, url: "https://example.org", description: "x".repeat(700), markdown: "not returned" },
		{ url: "https://example.com", description: 123 },
	] } }, () => {}));
	assert.deepEqual(await provider.search("q", 5), [
		{ title: "https://example.org", url: "https://example.org", snippet: "x".repeat(500) },
		{ title: "https://example.com", url: "https://example.com", snippet: "" },
	]);
});

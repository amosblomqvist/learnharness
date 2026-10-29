/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, exaProvider } from "../src/server/search.ts";

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
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
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

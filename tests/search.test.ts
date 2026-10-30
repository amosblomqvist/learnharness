/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave/Firecrawl adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, firecrawlProvider } from "../src/server/search.ts";

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

	it("Firecrawl ranks last — adding its key never changes an existing auto engine", () => {
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

	it("maps the {success:false, error} body into the message", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", async () =>
			new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid token" }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Firecrawl search API 401: Unauthorized: Invalid token/);
	});

	it("keeps the raw slice when the error body is not JSON", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", async () =>
			new Response("Payment Required", { status: 402 }),
		);
		await assert.rejects(provider.search("q", 5), /Firecrawl search API 402: Payment Required/);
	});
});

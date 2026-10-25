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
import { resolveSearchEngineFor, tavilyProvider, braveProvider, ollamaProvider } from "../src/server/search.ts";

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

	it("Ollama key alone enables search, without a model URL; existing engines keep priority", () => {
		const key = "ollama-cloud-key";
		assert.equal(resolveSearchEngineFor(undefined, { ollama: key }).engine, "ollama");
		assert.equal(resolveSearchEngineFor(undefined, { brave: "brave-key", ollama: key }).engine, "brave");
		assert.equal(resolveSearchEngineFor(undefined, { tavily: "tavily-key", brave: "brave-key", ollama: key }).engine, "tavily");
		assert.equal(resolveSearchEngineFor("ollama", { tavily: "tavily-key", ollama: key }).engine, "ollama");
		const missing = resolveSearchEngineFor("ollama", { tavily: "tavily-key" });
		assert.equal(missing.available, false);
		assert.match(missing.reason, /OLLAMA_API_KEY/);
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

describe("ollamaProvider (hosted Web Search and Web Fetch)", () => {
	it("calls ollama.com with bearer key, returns normalized hits and page content", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const provider = ollamaProvider("ollama-cloud-key", async (url, init) => {
			seen.push({ url, init });
			return Response.json(url.endsWith("web_search") ? {
				results: [{ title: "Example", url: "https://example.com", content: "first\nsecond" }, { title: "Missing URL" }],
			} : { title: "Example page", content: "# Page body" });
		});
		assert.deepEqual(await provider.search("test query", 5), [{ title: "Example", url: "https://example.com", snippet: "first second" }]);
		assert.deepEqual(await provider.fetchPage!("https://example.com"), { title: "Example page", content: "# Page body" });
		assert.deepEqual(seen.map(({ url, init }) => [url, init.method, (init.headers as Record<string, string>).authorization, JSON.parse(init.body as string)]), [
			["https://ollama.com/api/web_search", "POST", "Bearer ollama-cloud-key", { query: "test query", max_results: 5 }],
			["https://ollama.com/api/web_fetch", "POST", "Bearer ollama-cloud-key", { url: "https://example.com" }],
		]);
	});

	it("surfaces a failed Ollama call", async () => {
		const provider = ollamaProvider("ollama-cloud-key", async () => new Response("rate limited", { status: 429 }));
		await assert.rejects(provider.search("q", 5), /Ollama web_search API 429: rate limited/);
	});
});

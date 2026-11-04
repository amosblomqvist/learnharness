/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave/DeepSeek adapters against a STUB fetch (never
 * the network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, deepseekProvider } from "../src/server/search.ts";

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

describe("deepseekProvider (wire shape per api-docs.deepseek.com/guides/search)", () => {
	/** POST https://api.deepseek.com/v1/tools/search — the same Bearer key
	 *  family as the DeepSeek model API. `summary` is the model-facing
	 *  field, so it wins over the display `snippet`. */
	it("POSTs v1/tools/search with Bearer auth, count, and need_content:false", async () => {
		const provider = deepseekProvider("sk-throwawaykey0000001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/d", summary: "a model-ready\nsummary", snippet: "short" },
					{ title: "Fallback", url: "https://example.com/e", snippet: "display only" },
					{ title: "No URL", summary: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.deepseek.com/v1/tools/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer sk-throwawaykey0000001");
				assert.equal(headers["content-type"], "application/json");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.count, 5);
				// Full page text would blow the researcher's context — web_fetch
				// owns page bodies, so the adapter never asks for content.
				assert.equal(body.need_content, false);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [
			{ title: "Example", url: "https://example.com/d", snippet: "a model-ready summary" },
			{ title: "Fallback", url: "https://example.com/e", snippet: "display only" },
		]);
	});

	it("clamps count to the API's 1–50 window", async () => {
		const provider = deepseekProvider("sk-throwawaykey0000001", stubFetch({ results: [] }, (_url, init) => {
			assert.equal(JSON.parse(init.body as string).count, 50);
		}));
		assert.deepEqual(await provider.search("q", 999), []);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = deepseekProvider("sk-throwawaykey0000001", async () =>
			new Response("insufficient balance", { status: 402 }),
		);
		await assert.rejects(provider.search("q", 5), /DeepSeek search API 402: insufficient balance/);
	});
});

describe("deepseek in the engine order (auto-detect)", () => {
	it("a DeepSeek key alone activates the deepseek engine", () => {
		const out = resolveSearchEngineFor(undefined, { deepseek: "sk-throwawaykey0000001" });
		assert.ok(out.available);
		assert.equal(out.engine, "deepseek");
	});

	it("DEEPSEEK_API_KEY sits LAST — a dedicated search key outranks it", () => {
		// DEEPSEEK_API_KEY is also a model-provider key, so a chat-only
		// DeepSeek user must not lose their Tavily/Brave engine to it.
		const both = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			deepseek: "sk-throwawaykey0000001",
		});
		assert.equal(both.engine, "tavily");

		const brave = resolveSearchEngineFor(undefined, {
			brave: "brave-throwaway-key-00001",
			deepseek: "sk-throwawaykey0000001",
		});
		assert.equal(brave.engine, "brave");
	});

	it("pinning deepseek requires its key — no silent fallback to another engine", () => {
		const missing = resolveSearchEngineFor("deepseek", { tavily: "tvly-throwaway-key-00001" });
		assert.ok(!missing.available);
		assert.equal(missing.engine, null);
		assert.match(missing.reason, /DEEPSEEK_API_KEY/);

		const pinned = resolveSearchEngineFor("deepseek", {
			tavily: "tvly-throwaway-key-00001",
			deepseek: "sk-throwawaykey0000001",
		});
		assert.equal(pinned.engine, "deepseek");
	});
});

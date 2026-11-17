import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

// The live supplement (new-model wave, 2026-11-17): pi-ai ships a GENERATED
// OpenRouter snapshot, so a model released after that generation never
// reaches the picker. The server now merges OpenRouter's live `/models` rows
// into pi-ai's shipped catalog (unknown ids only, TTL-cached, best-effort)
// and re-registers the provider, so listing, settings validation, and engine
// resolution all agree. These tests drive that path with a fake fetch — no
// network, no paid models.

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-openrouter-live-"));
process.env.LH_DATA_DIR = path.join(testDir, "data");
process.env.LH_AUTH_FILE = path.join(testDir, "auth.json");
const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "test-key-openrouter-live";

const {
	mergeOpenRouterCatalog,
	modelCatalog,
	openRouterModelFromApi,
	refreshConnectionCatalog,
	refreshOpenRouterCatalog,
	validateChatSettings,
	validateModelsSettings,
} = await import("../src/server/model-catalog.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");

after(() => {
	if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
	fs.rmSync(testDir, { recursive: true, force: true });
});

/** OpenRouter's `GET /models` row for the model pi-ai's snapshot lacks
 *  (fields trimmed to the ones the projection reads). */
const sol62 = {
	id: "openai/gpt-6.2-sol",
	name: "OpenAI: GPT-6.2 Sol",
	context_length: 1_050_000,
	top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
	architecture: { input_modalities: ["file", "image", "text"], output_modalities: ["text"] },
	pricing: {
		prompt: "0.000002",
		completion: "0.00001",
		input_cache_read: "0.0000001",
		input_cache_write: "0.0000025",
		overrides: [
			{ min_prompt_tokens: 272_000, prompt: "0.000004", completion: "0.000015", input_cache_read: "0.0000002", input_cache_write: "0.000005" },
		],
	},
	reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "medium" },
	supported_parameters: ["include_reasoning", "reasoning", "reasoning_effort", "tools"],
	endpoints: ["/api/v1/chat/completions", "/api/v1/responses"],
};

/** A known id in the shipped catalog, priced absurdly in the live payload:
 *  the merge must keep pi-ai's curated row. */
const sol61WithWrongPrice = {
	...sol62,
	id: "openai/gpt-6.1-sol",
	name: "OpenAI: GPT-6.1 Sol (live)",
	pricing: { prompt: "0.5", completion: "0.5", input_cache_read: "0", input_cache_write: "0" },
};

/** A non-chat row (image/classifier-only): never merged. */
const imageOnly = {
	...sol62,
	id: "openai/gpt-6.2-sol-image",
	architecture: { input_modalities: ["text"], output_modalities: ["image"] },
	endpoints: ["/api/v1/images/generations"],
};

/** OpenRouter advertises the chat endpoint for its image models too; the
 *  shipped image row must not gain a chat twin. */
const imageChatTwin = {
	...sol62,
	id: "openai/gpt-5-image",
	name: "OpenAI: GPT-5 Image",
};

const jsonResponse = (data: unknown[]) =>
	new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

describe("the live OpenRouter catalog supplement", () => {
	it("maps an OpenRouter row to pi's chat shape, thinking truth, and tiered prices", () => {
		const model = openRouterModelFromApi(sol62);
		assert.ok(model, "a chat row maps");
		assert.equal(model!.id, "openai/gpt-6.2-sol");
		assert.equal(model!.name, "OpenAI: GPT-6.2 Sol");
		assert.equal(model!.api, "openai-completions");
		assert.equal(model!.provider, "openrouter");
		assert.equal(model!.baseUrl, "https://openrouter.ai/api/v1");
		assert.equal(model!.contextWindow, 1_050_000);
		assert.equal(model!.maxTokens, 128_000);
		assert.deepEqual(model!.input, ["text", "image"]);
		assert.deepEqual(model!.cost, {
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
		});
		// mandatory 6.2 reasoning: no "off", no "minimal" — exactly pi's 6.1 row.
		assert.deepEqual(getSupportedThinkingLevels(model!), ["low", "medium", "high", "xhigh", "max"]);

		// Optional reasoning offers "off"; non-chat and context-less rows are skipped.
		const optional = openRouterModelFromApi({ ...sol62, reasoning: { mandatory: false, supported_efforts: ["high"] } });
		assert.ok(optional);
		assert.deepEqual(getSupportedThinkingLevels(optional!), ["off", "high"]);
		assert.equal(openRouterModelFromApi(imageOnly), undefined);
		assert.equal(openRouterModelFromApi({ ...sol62, context_length: null, top_provider: {} }), undefined);
	});

	it("merges only unknown ids, dedupes, and never overrides curated metadata", () => {
		const shipped = piModels().getModels("openrouter");
		const knownIds = new Set([...shipped.map((m) => m.id), "openai/gpt-5-image"]);
		const merged = mergeOpenRouterCatalog(shipped, [sol62, sol62, sol61WithWrongPrice, imageOnly, imageChatTwin], knownIds);
		assert.equal(merged.length, shipped.length + 1, "exactly one new chat row");
		assert.ok(!merged.some((m) => m.id === "openai/gpt-5-image"), "no chat twin for a shipped image id");
		assert.equal(merged.filter((m) => m.id === "openai/gpt-6.2-sol").length, 1);
		const curated = merged.find((m) => m.id === "openai/gpt-6.1-sol");
		assert.ok(curated);
		assert.equal(curated!.name, "OpenAI: GPT-6.1 Sol");
		assert.equal(curated!.cost.input, 2, "shipped price survives a bogus live row");
	});

	it("fetches once, federates the new model, and validates/serves it end to end", async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		let requestedUrl = "";
		let authorization = "";
		globalThis.fetch = async (input, init) => {
			calls++;
			const request = new Request(input, init);
			requestedUrl = request.url;
			authorization = request.headers.get("authorization") ?? "";
			return jsonResponse([sol62, sol61WithWrongPrice, imageOnly, imageChatTwin]);
		};
		try {
			await refreshConnectionCatalog("openrouter");
			assert.equal(calls, 1);
			assert.equal(requestedUrl, "https://openrouter.ai/api/v1/models");
			assert.equal(authorization, "Bearer test-key-openrouter-live");

			const listed = modelCatalog().models.filter((m) => m.provider === "openrouter" && m.id === "openai/gpt-6.2-sol");
			assert.equal(listed.length, 1, "listed exactly once");
			const entry = listed[0]!;
			assert.deepEqual(entry.supportedLevels, ["low", "medium", "high", "xhigh", "max"]);
			assert.deepEqual(entry.input, ["text", "image"]);
			assert.equal(entry.cost?.input, 2);
			assert.equal(entry.contextWindow, 1_050_000);
			assert.equal(entry.maxTokens, 128_000);
			// The shipped image row stays image-only; no chat twin is minted.
			assert.ok(!modelCatalog().models.some((m) => m.provider === "openrouter" && m.id === "openai/gpt-5-image"));
			assert.ok(piModels().getAllModels("openrouter").some((m) => m.id === "openai/gpt-5-image"));

			// The shipped 6.1 row keeps its curated name and price.
			const curated = modelCatalog().models.find((m) => m.provider === "openrouter" && m.id === "openai/gpt-6.1-sol");
			assert.ok(curated);
			assert.equal(curated!.name, "OpenAI: GPT-6.1 Sol");
			assert.equal(curated!.cost?.input, 2);

			const model = { provider: "openrouter", id: "openai/gpt-6.2-sol" };
			assert.deepEqual(validateChatSettings({ model }), { ok: true });
			assert.deepEqual(validateModelsSettings({ strong: { model, thinkingLevel: "high" } }), { ok: true });
			const engine = piEngineForSpec(model);
			assert.equal(engine.model.id, "openai/gpt-6.2-sol");
			assert.equal(engine.model, piModels().getModel("openrouter", "openai/gpt-6.2-sol"));
			assert.equal(engine.level, "medium", "pi's default order picks the first supported level");

			// TTL cache: a second request inside the window makes no call.
			await refreshConnectionCatalog("openrouter");
			assert.equal(calls, 1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps the last good rows when the refresh fails or answers non-2xx", async () => {
		const originalFetch = globalThis.fetch;
		const listedIds = () =>
			modelCatalog().models.filter((m) => m.provider === "openrouter").map((m) => m.id);
		try {
			// Establish a good state first, independent of test order.
			globalThis.fetch = async () => jsonResponse([sol62]);
			await refreshOpenRouterCatalog({ force: true });
			assert.ok(listedIds().includes("openai/gpt-6.2-sol"), "good state established");

			globalThis.fetch = async () => {
				throw new Error("offline");
			};
			await refreshOpenRouterCatalog({ force: true });
			assert.ok(listedIds().includes("openai/gpt-6.2-sol"), "transport failure keeps last good");

			globalThis.fetch = async () => new Response("{}", { status: 500 });
			await refreshOpenRouterCatalog({ force: true });
			assert.ok(listedIds().includes("openai/gpt-6.2-sol"), "HTTP failure keeps last good");
			assert.ok(listedIds().includes("openai/gpt-6.1-sol"), "shipped catalog untouched");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not touch the network without an OpenRouter key", async () => {
		const originalFetch = globalThis.fetch;
		delete process.env.OPENROUTER_API_KEY;
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return jsonResponse([sol62]);
		};
		try {
			await refreshOpenRouterCatalog({ force: true });
			assert.equal(called, false, "no key, no fetch");
		} finally {
			globalThis.fetch = originalFetch;
			process.env.OPENROUTER_API_KEY = "test-key-openrouter-live";
		}
	});
});

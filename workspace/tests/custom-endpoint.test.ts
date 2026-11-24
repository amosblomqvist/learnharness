/**
 * Tests for the custom OpenAI-compatible endpoint (custom-endpoint wave).
 * Covers the pure core (normalizeBaseUrl, customProviderUsable, the sanitizer,
 * resolution), the deep server module (provider build + live sync + model
 * discovery incl. image-modality, reasoning detection and the per-model user
 * pins), the pins' strict write-side parser, and the catalog federation row.
 * No network: the discovery probe runs against a stubbed fetch.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	CUSTOM_MODEL_PIN_FLOOR,
	customProviderUsable,
	normalizeBaseUrl,
	parseModelIds,
	sanitizeCustomModelOverrides,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseCustomModelOverridesBody } from "../src/server/settings-body.ts";
import { CUSTOM_PROVIDER } from "../src/core/auth-keys.ts";
import {
	buildOpenAiCompatibleProvider,
	discoverModels,
	mergeManualModels,
} from "../src/server/custom-provider.ts";
import { piModels } from "../src/agent/models.ts";
import { getSupportedThinkingLevels, normalizeContext } from "@earendil-works/pi-ai";

// ─── normalizeBaseUrl ────────────────────────────────────────────────────────
describe("normalizeBaseUrl", () => {
	it("drops trailing slashes and keeps the path", () => {
		assert.equal(normalizeBaseUrl("https://host:8000/v1/"), "https://host:8000/v1");
		assert.equal(normalizeBaseUrl("  https://host/v1  "), "https://host/v1");
		assert.equal(normalizeBaseUrl("http://localhost:11434"), "http://localhost:11434");
	});
	it("rejects non-http(s) schemes and junk with empty string", () => {
		assert.equal(normalizeBaseUrl("file:///etc/passwd"), "");
		assert.equal(normalizeBaseUrl("not a url"), "");
		assert.equal(normalizeBaseUrl(""), "");
	});
});

// ─── customProviderUsable ────────────────────────────────────────────────────
describe("customProviderUsable", () => {
	it("is true exactly when a base URL is set (the key is optional)", () => {
		assert.equal(customProviderUsable({ baseUrl: "https://h/v1" }), true);
		assert.equal(customProviderUsable({ baseUrl: "" }), false);
		assert.equal(customProviderUsable({}), false);
		assert.equal(customProviderUsable(undefined), false);
	});
});

// ─── sanitizer ───────────────────────────────────────────────────────────────
describe("sanitizeUserSettings — customProvider", () => {
	it("normalizes the base URL and cleans the model list (trim, dedupe, image flag)", () => {
		const out = sanitizeUserSettings({
			customProvider: {
				baseUrl: "https://host:8000/v1/",
				models: [
					{ id: " llama-3 " }, // trims id; image absent
					{ id: "gpt", image: true },
					{ id: "gpt", image: false }, // dup id wins (last) → image dropped
					{ id: "" }, // dropped: no usable id
					"not-an-object", // dropped
				],
			},
		});
		const cp = out?.customProvider;
		assert.equal(cp?.baseUrl, "https://host:8000/v1");
		assert.deepEqual(cp?.models, [{ id: "llama-3" }, { id: "gpt" }]);
	});
	it("keeps image:true and drops a non-array models list / invalid base URL", () => {
		const out = sanitizeUserSettings({ customProvider: { baseUrl: "ftp://x", models: "nope" } });
		assert.equal(out?.customProvider?.baseUrl, undefined);
		assert.equal(out?.customProvider?.models, undefined);
	});
	it("keeps reasoning:true and drops a non-true reasoning flag", () => {
		const out = sanitizeUserSettings({
			customProvider: {
				baseUrl: "https://h/v1",
				models: [{ id: "thinker", reasoning: true }, { id: "plain", reasoning: "yes" }],
			},
		});
		assert.deepEqual(out?.customProvider?.models, [{ id: "thinker", reasoning: true }, { id: "plain" }]);
	});
});

// ─── per-model pins: the read side + THE prune law ───────────────────────────
describe("sanitizeUserSettings / sanitizeCustomModelOverrides — pins", () => {
	it("keeps all positive integer pins and reasoning:false", () => {
		const out = sanitizeUserSettings({
			customProvider: {
				baseUrl: "https://h/v1",
				overrides: {
					llama: { context: 131072, maxTokens: 8192, reasoning: true },
					qwen: { context: 10 }, // Small positive budgets are preserved.
					quiet: { reasoning: false }, // a real pin, not an absent one
					junk: { context: "big", maxTokens: -1, reasoning: "yes" }, // every field junk
					" ": { context: 4096 }, // no usable id
					nope: "not-an-object",
				},
			},
		});
		assert.deepEqual(out?.customProvider?.overrides, {
			llama: { context: 131072, maxTokens: 8192, reasoning: true },
			qwen: { context: 10 },
			quiet: { reasoning: false },
		});
	});
	it("prunes pins for models the endpoint no longer advertises — the single prune law", () => {
		const pins = { a: { context: 32768 }, b: { context: 32768 } };
		assert.deepEqual(Object.keys(sanitizeCustomModelOverrides(pins, ["a"])), ["a"]);
		assert.deepEqual(
			Object.keys(sanitizeCustomModelOverrides(pins)),
			["a", "b"],
			"no liveIds → no prune (that is the routes' call, not the record sanitizer's)",
		);
		assert.deepEqual(sanitizeCustomModelOverrides("nope"), {}, "a non-object map resolves empty");
	});
	it("drops an invalid overrides section from the record entirely", () => {
		const out = sanitizeUserSettings({ customProvider: { baseUrl: "https://h/v1", overrides: "nope" } });
		assert.equal(out?.customProvider?.overrides, undefined);
	});
});

// ─── pins: the strict write side (PATCH) ──────────────────────────────────
describe("parseCustomModelOverridesBody — the strict write side", () => {
	it("accepts whole counts at or above the floor and the tri-state reasoning pin", () => {
		const r = parseCustomModelOverridesBody({
			overrides: {
				a: { context: CUSTOM_MODEL_PIN_FLOOR, reasoning: false },
				b: { maxTokens: 8192 },
				c: {}, // an empty pin is legal — the sanitizer drops it on write
			},
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			a: { context: CUSTOM_MODEL_PIN_FLOOR, reasoning: false },
			b: { maxTokens: 8192 },
			c: {},
		});
	});
	it("rejects a count under the floor, naming the floor", () => {
		const r = parseCustomModelOverridesBody({ overrides: { a: { context: CUSTOM_MODEL_PIN_FLOOR - 1 } } });
		assert.equal(r.ok, false);
		if (!r.ok) assert.ok(r.error.includes(String(CUSTOM_MODEL_PIN_FLOOR)), r.error);
	});
	it("rejects a fractional count, a non-boolean reasoning, and a missing overrides map", () => {
		assert.equal(parseCustomModelOverridesBody({ overrides: { a: { context: 4096.5 } } }).ok, false);
		assert.equal(parseCustomModelOverridesBody({ overrides: { a: { reasoning: "on" } } }).ok, false);
		assert.equal(parseCustomModelOverridesBody({ overrides: { a: "nope" } }).ok, false);
		assert.equal(parseCustomModelOverridesBody({}).ok, false);
		assert.equal(parseCustomModelOverridesBody(null).ok, false);
	});
});

// ─── resolution ──────────────────────────────────────────────────────────
describe("resolveSettings — customProvider", () => {
	it("resolves an absent section to concrete defaults", () => {
		assert.deepEqual(resolveSettings(null).customProvider, { baseUrl: "", models: [], overrides: {}, manualModels: [] });
	});
	it("carries stored pins through to the concrete view", () => {
		const resolved = resolveSettings({
			version: 1,
			customProvider: { baseUrl: "http://h/v1", models: [{ id: "a" }], overrides: { a: { context: 32768 } } },
		});
		assert.deepEqual(resolved.customProvider.overrides, { a: { context: 32768 } });
	});
	it("carries stored manual model ids through to the concrete view", () => {
		const resolved = resolveSettings({
			version: 1,
			customProvider: { baseUrl: "http://h/v1", models: [{ id: "a" }], manualModels: ["a"] },
		});
		assert.deepEqual(resolved.customProvider.manualModels, ["a"]);
	});
});

describe("manual model ids", () => {
	it("parseModelIds splits a typed list on commas and whitespace, trims and dedupes", () => {
		assert.deepEqual(parseModelIds(" doubao-seed-2.1-pro, kimi-k3.1-pro\nqwen/qwen3-max ,, kimi-k3.1-pro "), [
			"doubao-seed-2.1-pro",
			"kimi-k3.1-pro",
			"qwen/qwen3-max",
		]);
	});
	it("parseModelIds accepts a string array and ignores non-strings and junk", () => {
		assert.deepEqual(parseModelIds(["a", " b ", "", 3, null, "a"]), ["a", "b"]);
		assert.deepEqual(parseModelIds(undefined), []);
		assert.deepEqual(parseModelIds({ id: "a" }), []);
	});
	it("the sanitizer keeps a clean manual list and drops an empty one", () => {
		const kept = sanitizeUserSettings({ version: 1, customProvider: { baseUrl: "http://h/v1", manualModels: [" a ", "a", "b"] } });
		assert.deepEqual(kept?.customProvider?.manualModels, ["a", "b"]);
		const dropped = sanitizeUserSettings({ version: 1, customProvider: { baseUrl: "http://h/v1", manualModels: [] } });
		assert.equal(dropped?.customProvider?.manualModels, undefined);
	});
	it("mergeManualModels adds typed ids with defaults and never replaces discovered metadata", () => {
		const merged = mergeManualModels([{ id: "b", image: true, context: 65536 }], ["c", "b", "a"]);
		assert.deepEqual(merged, [{ id: "a" }, { id: "b", image: true, context: 65536 }, { id: "c" }]);
	});
	it("mergeManualModels alone builds the list when discovery found nothing", () => {
		assert.deepEqual(mergeManualModels([], ["x"]), [{ id: "x" }]);
	});
});

// ─── provider build + live sync ──────────────────────────────────────────────
describe("buildOpenAiCompatibleProvider / syncCustomProvider", () => {
	after(() => piModels().deleteProvider(CUSTOM_PROVIDER.id));

	it("maps ids to defaults and marks image-capable models image-input", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "m1" }, { id: "m2", image: true }],
		});
		assert.equal(provider.id, CUSTOM_PROVIDER.id);
		const [m1, m2] = provider.getModels();
		assert.equal(m1!.name, "m1");
		assert.equal(m1!.api, "openai-completions");
		assert.equal(m1!.provider, CUSTOM_PROVIDER.id);
		assert.equal(m1!.baseUrl, "http://h/v1");
		assert.equal(m1!.contextWindow, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW);
		assert.equal(m1!.maxTokens, CUSTOM_MODEL_DEFAULT_MAX_TOKENS);
		assert.deepEqual(m1!.input, ["text"]); // text-only by default
		assert.deepEqual(m2!.input, ["text", "image"]); // image-capable → Vision-eligible
		assert.equal(m1!.contextWindow, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW); // no endpoint value → default
		assert.equal(m1!.maxTokens, CUSTOM_MODEL_DEFAULT_MAX_TOKENS);
	});

	it("carries endpoint token limits when present", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "big", context: 196608, maxTokens: 393216 }],
		});
		const [big] = provider.getModels();
		assert.equal(big!.contextWindow, 196608); // 192k from the endpoint
		assert.equal(big!.maxTokens, 393216);
	});

	it("a user pin beats the endpoint, which beats the compiled default", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "pinned", context: 32768, maxTokens: 4096 }, { id: "detected", context: 65536 }, { id: "bare" }],
			overrides: { pinned: { context: 131072, maxTokens: 16384 } },
		});
		const [pinned, detected, bare] = provider.getModels();
		assert.equal(pinned!.contextWindow, 131072, "the pin wins over the endpoint's own number");
		assert.equal(pinned!.maxTokens, 16384);
		assert.equal(detected!.contextWindow, 65536, "no pin → the endpoint's value");
		assert.equal(detected!.maxTokens, CUSTOM_MODEL_DEFAULT_MAX_TOKENS, "endpoint silent → the compiled default");
		assert.equal(bare!.contextWindow, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW);
	});

	it("the thinking pin is tri-state: false beats a detected-true endpoint, true beats silence", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "liar", reasoning: true }, { id: "silent" }],
			overrides: { liar: { reasoning: false }, silent: { reasoning: true } },
		});
		const [liar, silent] = provider.getModels();
		assert.equal(liar!.reasoning, false, "a server that advertises reasoning but rejects it can be pinned off");
		assert.deepEqual(getSupportedThinkingLevels(liar!), ["off"]);
		assert.equal(silent!.reasoning, true, "LM Studio publishes nothing; the user says otherwise");
		assert.deepEqual(getSupportedThinkingLevels(silent!), ["off", "minimal", "low", "medium", "high"]);
	});

	it("gives a reasoning-capable model the standard thinking levels (others stay \"off\")", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "thinker", reasoning: true }, { id: "plain" }],
		});
		const [thinker, plain] = provider.getModels();
		assert.equal(thinker!.reasoning, true);
		// No thinkingLevelMap → pi-ai's default set, same as any reasoning model.
		assert.deepEqual(getSupportedThinkingLevels(thinker!), ["off", "minimal", "low", "medium", "high"]);
		assert.equal(plain!.reasoning, false);
		assert.deepEqual(getSupportedThinkingLevels(plain!), ["off"]);
	});

	it("registers the native provider in the shared collection", () => {
		piModels().setProvider(buildOpenAiCompatibleProvider({ baseUrl: "http://h/v1", models: [{ id: "live" }] }));
		assert.ok(piModels().getProvider(CUSTOM_PROVIDER.id), "provider registered");
		assert.ok(piModels().getModel(CUSTOM_PROVIDER.id, "live"), "model resolvable");
		piModels().deleteProvider(CUSTOM_PROVIDER.id);
		assert.equal(piModels().getProvider(CUSTOM_PROVIDER.id), undefined, "provider removed");
	});
});

// ─── discovery (stubbed fetch) ───────────────────────────────────────────────
describe("discoverModels", () => {
	const realFetch = globalThis.fetch;
	after(() => {
		globalThis.fetch = realFetch;
	});

	function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
		globalThis.fetch = (async (input: unknown) => {
			const res = handler(String(input));
			return new Response(JSON.stringify(res.body), { status: res.status });
		}) as unknown as typeof fetch;
	}

	it("reads OpenAI {data:[{id}]} and Ollama {models:[{id}]} shapes", async () => {
		stubFetch(() => ({ status: 200, body: { data: [{ id: "b" }, { id: "a" }] } }));
		const openai = await discoverModels("http://h/v1");
		assert.ok(openai.ok);
		assert.deepEqual(openai.models, [{ id: "a" }, { id: "b" }]);
		stubFetch(() => ({ status: 200, body: { models: [{ id: "x" }] } }));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok && r.models.length === 1 && r.models[0]!.id === "x");
	});
	it("detects image capability from common modality fields", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "vision-model", architecture: { input_modalities: ["text", "image"] } },
					{ id: "cap-model", capabilities: ["completion", "vision"] },
					{ id: "text-model", architecture: { input_modalities: ["text"] } },
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, Boolean(m.image)]));
		assert.equal(byId["vision-model"], true);
		assert.equal(byId["cap-model"], true);
		assert.equal(byId["text-model"], false);
	});
	it("detects token limits from common metadata fields", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "big", max_input_tokens: 196608, max_output_tokens: 393216 },
					{ id: "ctx", context_length: 32768 },
					{ id: "plain" },
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
		assert.equal(byId["big"]!.context, 196608);
		assert.equal(byId["big"]!.maxTokens, 393216);
		assert.equal(byId["ctx"]!.context, 32768);
		assert.equal(byId["ctx"]!.maxTokens, undefined);
		assert.equal(byId["plain"]!.context, undefined);
	});
	it("reads nested token limits as independent fallbacks", async () => {
		const limit = { context: 1050000, input: 922000, output: 128000 };
		const data = [
			{ id: "nested", limit },
			{ id: "flat", context_length: 32768, max_output_tokens: 4096, limit },
			{ id: "mixed", meta: { n_ctx: 65536 }, limit },
			{ id: "invalid", limit: { input: 922000, context: -1, output: "128000" } },
		];
		stubFetch(() => ({ status: 200, body: { data } }));
		const result = await discoverModels("http://h/v1");
		assert.ok(result.ok);
		assert.deepEqual(result.models, [
			{ id: "flat", context: 32768, maxTokens: 4096 },
			{ id: "invalid" },
			{ id: "mixed", context: 65536, maxTokens: 128000 },
			{ id: "nested", context: 1050000, maxTokens: 128000 },
		]);
	});
	it("discovered nested limits restore serialized output room while pins still win", async () => {
		stubFetch(() => ({ status: 200, body: { data: [{ id: "gpt-6.1-sol", reasoning: true, limit: { context: 1050000, output: 128000 } }] } }));
		const result = await discoverModels("http://h/v1");
		assert.ok(result.ok);
		const models = piModels();
		const context = normalizeContext({ systemPrompt: "Offline", messages: [{ role: "user", content: "x".repeat(21861), timestamp: 1 }] });
		let fetched = false;
		globalThis.fetch = async () => { fetched = true; throw new Error("CLOSED: unexpected inference fetch"); };
		try {
			for (const [rows, overrides, expected] of [
				[[{ id: "gpt-6.1-sol", reasoning: true }], undefined, 1],
				[result.models, undefined, 128000],
				[result.models, { "gpt-6.1-sol": { context: 32768, maxTokens: 4096 } }, 4096],
			] as const) {
				models.setProvider(buildOpenAiCompatibleProvider({ baseUrl: "http://h/v1", models: rows, overrides }));
				let payload: unknown;
				const reply = await models.streamSimple(models.getModel("custom", "gpt-6.1-sol")!, context, {
					reasoning: "high", onPayload: (value) => { payload = value; throw new Error("CLOSED: payload captured"); },
				}).result();
				assert.match(reply.errorMessage ?? "", /CLOSED: payload captured/);
				assert.equal((payload as { max_completion_tokens: number }).max_completion_tokens, expected);
			}
			assert.equal(fetched, false, "serialization stops before any provider request");
		} finally { models.deleteProvider("custom"); }
	});
	it("validates nested fields independently and skips invalid higher-priority metadata", async () => {
		const cases: { row: Record<string, unknown>; limits: { context?: number; maxTokens?: number } }[] = [
			{ row: { context_length: 0, meta: { n_ctx: -1 }, max_output_tokens: "4096", limit: { context: 65536, output: 8192 } }, limits: { context: 65536, maxTokens: 8192 } },
			{ row: { max_output_tokens: 4096, limit: { context: 65536, output: 8192 } }, limits: { context: 65536, maxTokens: 4096 } },
			{ row: { limit: { context: 1, output: 1 } }, limits: { context: 1, maxTokens: 1 } },
			{ row: { limit: { input: 922000, output: 8192 } }, limits: { maxTokens: 8192 } },
			...[-1, 0, 1.5, "65536", true, null, [], {}].map((value) => ({ row: { limit: { context: value, output: 8192 } }, limits: { maxTokens: 8192 } })),
			...[-1, 0, 1.5, "8192", true, null, [], {}].map((value) => ({ row: { limit: { context: 65536, output: value } }, limits: { context: 65536 } })),
			...[null, [], [{ context: 65536, output: 8192 }], "limits", 65536].map((limit) => ({ row: { limit }, limits: {} })),
		];
		for (const { row, limits } of cases) {
			stubFetch(() => ({ status: 200, body: { data: [{ id: "fixture", ...row }] } }));
			const result = await discoverModels("http://h/v1");
			assert.ok(result.ok);
			assert.deepEqual(result.models, [{ id: "fixture", ...limits }], JSON.stringify(row));
		}
	});
	it("detects llama.cpp's runtime context from meta.n_ctx, not n_ctx_train", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "llamacpp", owned_by: "llamacpp", meta: { n_ctx: 65536, n_ctx_train: 262144, n_vocab: 151936 } },
					{ id: "train-only", owned_by: "llamacpp", meta: { n_ctx_train: 262144 } },
					{ id: "top-level-wins", context_length: 32768, meta: { n_ctx: 65536 } },
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
		assert.equal(byId["llamacpp"]!.context, 65536);
		assert.equal(byId["train-only"]!.context, undefined, "the training maximum is not what the server accepts");
		assert.equal(byId["top-level-wins"]!.context, 32768);
	});
	it("detects reasoning from endpoint metadata only — never from the model name", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "vllm-reasoner", supported_parameters: ["temperature", "reasoning", "reasoning_effort"] },
					{ id: "bool-reasoner", reasoning: true },
					{ id: "thinking-flag", thinking: true },
					{ id: "cap-reasoner", capabilities: ["completion", "reasoning"] },
					{ id: "deepseek-r1-distill" }, // a reasoning-sounding NAME, no metadata → stays off
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, Boolean(m.reasoning)]));
		assert.equal(byId["vllm-reasoner"], true);
		assert.equal(byId["bool-reasoner"], true);
		assert.equal(byId["thinking-flag"], true);
		assert.equal(byId["cap-reasoner"], true);
		assert.equal(byId["deepseek-r1-distill"], false, "name guessing would risk sending reasoning_effort to a server that rejects it");
	});

	it("guards the scheme before any fetch", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const r = await discoverModels("file:///etc/passwd");
		assert.equal(r.ok, false);
		assert.equal(called, false, "no fetch for a non-http scheme");
	});
	it("reports a non-2xx and an unparseable shape as honest errors", async () => {
		stubFetch(() => ({ status: 500, body: {} }));
		assert.equal((await discoverModels("http://h/v1")).ok, false);
		stubFetch(() => ({ status: 200, body: { unexpected: true } }));
		assert.equal((await discoverModels("http://h/v1")).ok, false);
	});
});

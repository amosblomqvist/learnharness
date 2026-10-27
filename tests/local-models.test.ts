import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
	normalizeOllamaRootUrl,
	normalizeOpenAIBaseUrl,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import {
	clearOllamaShowCache,
	ollamaShowCache,
	probeOllama,
	probeVLLM,
	VISION_MODEL_RE,
} from "../src/server/local-models.ts";
import {
	clearLocalProvider,
	createLocalProvider,
	piModels,
	setLocalProvider,
	toPiModelDefinition,
} from "../src/agent/models.ts";
import { parseLocalProvidersSettingsBody } from "../src/server/settings-body.ts";
import { resolveKeyStatuses } from "../src/server/keys.ts";
import type { ModelCatalogEntry } from "../src/core/contracts/models.ts";

describe("local models URL normalization", () => {
	it("normalizeOllamaRootUrl strips trailing slashes and /v1", () => {
		assert.equal(normalizeOllamaRootUrl("http://localhost:11434"), "http://localhost:11434");
		assert.equal(normalizeOllamaRootUrl("http://localhost:11434/"), "http://localhost:11434");
		assert.equal(normalizeOllamaRootUrl("http://localhost:11434/v1"), "http://localhost:11434");
		assert.equal(normalizeOllamaRootUrl("http://localhost:11434/v1/"), "http://localhost:11434");
	});

	it("normalizeOpenAIBaseUrl ensures trailing /v1", () => {
		assert.equal(normalizeOpenAIBaseUrl("http://localhost:8000"), "http://localhost:8000/v1");
		assert.equal(normalizeOpenAIBaseUrl("http://localhost:8000/"), "http://localhost:8000/v1");
		assert.equal(normalizeOpenAIBaseUrl("http://localhost:8000/v1"), "http://localhost:8000/v1");
		assert.equal(normalizeOpenAIBaseUrl("http://localhost:8000/v1/"), "http://localhost:8000/v1");
	});
});

describe("probeOllama discovery", () => {
	beforeEach(() => {
		clearOllamaShowCache();
	});

	it("filters embedding-only models and inspects chat model capabilities", async () => {
		let showCalls = 0;
		const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/tags")) {
				return new Response(
					JSON.stringify({
						models: [
							{ name: "qwen2.5-coder:14b", digest: "sha256:11111" },
							{ name: "nomic-embed-text:latest", digest: "sha256:22222" },
							{ name: "llava:7b", digest: "sha256:33333" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.endsWith("/api/show")) {
				showCalls++;
				const body = JSON.parse(String(init?.body)) as { name: string };
				if (body.name.includes("nomic-embed")) {
					return new Response(
						JSON.stringify({
							capabilities: ["embedding"],
							details: { family: "nomic-bert" },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (body.name.includes("llava")) {
					return new Response(
						JSON.stringify({
							capabilities: ["completion", "vision"],
							parameters: "num_ctx 8192",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						capabilities: ["completion", "tools"],
						parameters: "num_ctx 16384",
						model_info: { "qwen2.context_length": 32768 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not found", { status: 404 });
		};

		const res = await probeOllama("http://localhost:11434/v1", 32768, mockFetch as typeof fetch);
		assert.ok(res.ok);
		assert.equal(res.models.length, 2, "nomic-embed-text should be filtered out");

		const qwen = res.models.find((m) => m.id === "qwen2.5-coder:14b");
		assert.ok(qwen);
		assert.equal(qwen.provider, "ollama");
		assert.equal(qwen.contextWindow, 16384, "parameters num_ctx takes precedence");
		assert.equal(qwen.maxTokens, 4096);
		assert.deepEqual(qwen.input, ["text"]);
		assert.deepEqual(qwen.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const llava = res.models.find((m) => m.id === "llava:7b");
		assert.ok(llava);
		assert.deepEqual(llava.input, ["text", "image"], "vision capability detected");
		assert.equal(llava.contextWindow, 8192);

		// Subsequent call should hit digest cache without additional /api/show calls
		const initialShowCalls = showCalls;
		const res2 = await probeOllama("http://localhost:11434", 32768, mockFetch as typeof fetch);
		assert.ok(res2.ok);
		assert.equal(showCalls, initialShowCalls, "cached models should not re-query /api/show");
	});

	it("does not cache transient show failures in ollamaShowCache", async () => {
		let attempts = 0;
		const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/tags")) {
				return new Response(
					JSON.stringify({
						models: [{ name: "temp-model:latest", digest: "sha256:temp123" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.endsWith("/api/show")) {
				attempts++;
				if (attempts === 1) {
					// Simulate transient timeout / 500 error
					return new Response("Internal Server Error", { status: 500 });
				}
				return new Response(
					JSON.stringify({
						capabilities: ["completion", "vision"],
						parameters: "num_ctx 16384",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not found", { status: 404 });
		};

		const res1 = await probeOllama("http://localhost:11434", 4096, mockFetch as typeof fetch);
		assert.ok(res1.ok);
		// Transient failure should NOT have been cached
		assert.equal(ollamaShowCache.has("temp-model:latest:sha256:temp123"), false);

		// Second attempt succeeds and caches the actual metadata
		const res2 = await probeOllama("http://localhost:11434", 4096, mockFetch as typeof fetch);
		assert.ok(res2.ok);
		assert.equal(ollamaShowCache.has("temp-model:latest:sha256:temp123"), true);
		const cached = ollamaShowCache.get("temp-model:latest:sha256:temp123");
		assert.equal(cached?.contextWindow, 16384);
		assert.equal(cached?.isVision, true);
	});
});

describe("probeVLLM discovery", () => {
	it("extracts max_model_len and sends bearer token", async () => {
		let authHeaderReceived: string | null = null;
		const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const headers = init?.headers as Record<string, string> | undefined;
			authHeaderReceived = headers?.Authorization ?? null;

			return new Response(
				JSON.stringify({
					data: [
						{ id: "Qwen/Qwen2.5-Coder-32B-Instruct", max_model_len: 65536 },
						{ id: "mistralai/Mistral-7B-Instruct-v0.3", context_length: 32768 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const res = await probeVLLM("http://localhost:8000", "my-secret-token", 32768, mockFetch as typeof fetch);
		assert.ok(res.ok);
		assert.equal(authHeaderReceived, "Bearer my-secret-token");
		assert.equal(res.models.length, 2);

		const qwen = res.models.find((m) => m.id === "Qwen/Qwen2.5-Coder-32B-Instruct");
		assert.ok(qwen);
		assert.equal(qwen.provider, "custom");
		assert.equal(qwen.contextWindow, 65536);
		assert.equal(qwen.cost.input, 0);

		const mistral = res.models.find((m) => m.id === "mistralai/Mistral-7B-Instruct-v0.3");
		assert.ok(mistral);
		assert.equal(mistral.contextWindow, 32768);
	});

	it("detects vision capability on models like minicpm-v, qwen2-vl, and pixtral", async () => {
		const mockFetch = async (): Promise<Response> => {
			return new Response(
				JSON.stringify({
					data: [
						{ id: "openbmb/MiniCPM-V-2_6", max_model_len: 4096 },
						{ id: "mistralai/Pixtral-12B-2409", max_model_len: 16384 },
						{ id: "THUDM/glm-4v-9b", max_model_len: 8192 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const res = await probeVLLM("http://localhost:8000/v1", undefined, 32768, mockFetch as typeof fetch);
		assert.ok(res.ok);
		assert.equal(res.models.length, 3);
		assert.ok(res.models.every((m) => m.input.includes("image")), "all should be detected as vision capable");
	});

	it("VISION_MODEL_RE discriminates vl without false positives on vllm, eval, or novel", () => {
		// Negative cases (should NOT be detected as vision)
		assert.equal(VISION_MODEL_RE.test("vllm/Qwen2.5-Coder-7B"), false);
		assert.equal(VISION_MODEL_RE.test("vllm-llama3-instruct"), false);
		assert.equal(VISION_MODEL_RE.test("meta-llama/Llama-3.1-8B-eval"), false);
		assert.equal(VISION_MODEL_RE.test("novel-writer-14b"), false);

		// Positive cases (should be detected as vision)
		assert.equal(VISION_MODEL_RE.test("Qwen/Qwen2-VL-7B-Instruct"), true);
		assert.equal(VISION_MODEL_RE.test("qwen2.5_vl_7b"), true);
		assert.equal(VISION_MODEL_RE.test("openbmb/MiniCPM-V-2_6"), true);
		assert.equal(VISION_MODEL_RE.test("THUDM/glm-4v-9b"), true);
		assert.equal(VISION_MODEL_RE.test("OpenGVLab/InternVL2-8B"), true);
		assert.equal(VISION_MODEL_RE.test("mistralai/Pixtral-12B-2409"), true);
	});
});

describe("createLocalProvider and compatibility flags", () => {
	it("configures ApiKeyAuth contract and strict compatibility flags", async () => {
		const entry: ModelCatalogEntry = {
			id: "qwen2.5:14b",
			name: "Ollama / qwen2.5:14b",
			provider: "ollama",
			reasoning: false,
			input: ["text"],
			supportedLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 2048,
		};

		const piModel = toPiModelDefinition(entry, "http://localhost:11434/v1");
		assert.equal(piModel.api, "openai-completions");
		assert.equal(piModel.baseUrl, "http://localhost:11434/v1");
		assert.equal(piModel.compat?.supportsStore, false);
		assert.equal(piModel.compat?.supportsDeveloperRole, false);
		assert.equal(piModel.compat?.supportsStrictMode, false);
		assert.equal(piModel.compat?.maxTokensField, "max_tokens");
		assert.equal(piModel.compat?.supportsReasoningEffort, false);

		// Tight VRAM maxTokens clamp check
		const tightEntry: ModelCatalogEntry = {
			...entry,
			contextWindow: 2048,
			maxTokens: 0,
		};
		const clampedModel = toPiModelDefinition(tightEntry, "http://localhost:11434/v1");
		assert.equal(clampedModel.maxTokens, 1024, "clamped to half of context window");

		// Provider creation & ApiKeyAuth structure
		const provider = createLocalProvider("ollama", "http://localhost:11434", undefined, [entry]);
		assert.equal(provider.id, "ollama");
		assert.ok(provider.auth.apiKey);
		assert.equal(provider.auth.apiKey.name, "Ollama");

		// Test resolve contract
		const resolved = await provider.auth.apiKey.resolve({} as never);
		assert.equal(resolved?.auth.apiKey, "ollama");
		assert.equal(resolved?.source, "local");

		// Register in piModels collection and verify retrieval
		setLocalProvider(provider);
		const models = piModels();
		const retrieved = models.getModel("ollama", "qwen2.5:14b");
		assert.ok(retrieved);
		assert.equal(retrieved.id, "qwen2.5:14b");

		// De-register on disable
		clearLocalProvider("ollama");
		const cleared = models.getModel("ollama", "qwen2.5:14b");
		assert.equal(cleared, undefined, "model must be removed after clear");
	});
});

describe("settings parsing and sanitization", () => {
	it("parseLocalProvidersSettingsBody validates valid config", () => {
		const parsed = parseLocalProvidersSettingsBody({
			ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434" },
			custom: { enabled: false, baseUrl: "http://127.0.0.1:8000/v1", defaultContextWindow: 65536 },
		});
		assert.ok(parsed.ok);
		if (parsed.ok) {
			assert.equal(parsed.settings.ollama?.enabled, true);
			assert.equal(parsed.settings.ollama?.baseUrl, "http://127.0.0.1:11434");
			assert.equal(parsed.settings.custom?.defaultContextWindow, 65536);
		}
	});

	it("sanitizeUserSettings preserves and clamps localProviders delta", () => {
		const sanitized = sanitizeUserSettings({
			version: 1,
			localProviders: {
				ollama: { enabled: true, baseUrl: "  http://localhost:11434  " },
				custom: { defaultContextWindow: -5 }, // invalid positive number
			},
		});
		assert.ok(sanitized);
		assert.equal(sanitized?.localProviders?.ollama?.enabled, true);
		assert.equal(sanitized?.localProviders?.ollama?.baseUrl, "http://localhost:11434");
		assert.equal(sanitized?.localProviders?.custom?.defaultContextWindow, undefined);
	});
});

describe("LOCAL_AI_API_KEY resolution", () => {
	it("resolveKeyStatuses includes LOCAL_AI_API_KEY when present in file or env", () => {
		const statuses = resolveKeyStatuses(
			{ LOCAL_AI_API_KEY: "secret-token-12345" },
			{},
			new Set(),
		);
		const localKey = statuses.find((s) => s.id === "LOCAL_AI_API_KEY");
		assert.ok(localKey);
		assert.equal(localKey.present, true);
		assert.equal(localKey.source, "file");
	});

	it("extracts localProviders across top-level, settings, and effective wrappers", () => {
		const payload1 = { settings: { localProviders: { ollama: { enabled: true, baseUrl: "http://localhost:11434" } } } };
		const payload2 = { effective: { localProviders: { custom: { enabled: true, baseUrl: "http://localhost:8000/v1" } } } };
		const payload3 = { localProviders: { ollama: { enabled: false } } };

		const extract = (data: Record<string, unknown>) => {
			const root = (data.effective ?? data.settings ?? data) as { localProviders?: unknown };
			return root.localProviders;
		};

		assert.ok(extract(payload1));
		assert.ok(extract(payload2));
		assert.ok(extract(payload3));
	});

	it("extracts LOCAL_AI_API_KEY across array, keys, rows, and statuses wrapper shapes", () => {
		const matchKey = (data: unknown) => {
			const list = Array.isArray(data)
				? data
				: ((data as { keys?: unknown[]; rows?: unknown[]; statuses?: unknown[] })?.keys ??
				   (data as { rows?: unknown[] })?.rows ??
				   (data as { statuses?: unknown[] })?.statuses ??
				   []);
			return (list as Array<{ id?: string; present?: boolean }>).find((k) => k.id === "LOCAL_AI_API_KEY")?.present ?? false;
		};

		assert.equal(matchKey({ keys: [{ id: "LOCAL_AI_API_KEY", present: true }] }), true);
		assert.equal(matchKey({ rows: [{ id: "LOCAL_AI_API_KEY", present: true }] }), true);
		assert.equal(matchKey({ statuses: [{ id: "LOCAL_AI_API_KEY", present: true }] }), true);
		assert.equal(matchKey([{ id: "LOCAL_AI_API_KEY", present: true }]), true);
		assert.equal(matchKey({ keys: [{ id: "OTHER_KEY", present: true }] }), false);
	});

	it("dirty check accurately guards saved vs cleared vs new keys", () => {
		const isKeyDirty = (customKey: string, hasSavedKey: boolean) =>
			customKey !== (hasSavedKey ? "••••••••" : "");

		// Hydrated with saved key: mask is clean
		assert.equal(isKeyDirty("••••••••", true), false);
		// User clears saved key: dirty (must trigger deletion on save)
		assert.equal(isKeyDirty("", true), true);
		// User enters new key: dirty (must trigger PUT on save)
		assert.equal(isKeyDirty("my-new-token", true), true);

		// Unhydrated or no saved key: empty is clean
		assert.equal(isKeyDirty("", false), false);
		// User enters key when previously none existed: dirty
		assert.equal(isKeyDirty("new-token", false), true);
	});
});

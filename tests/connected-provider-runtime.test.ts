import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { customProvider, endpointFetch, subscriptionAliases } from "../src/agent/connected-providers.ts";
import type { CustomProviderDefinition } from "../src/core/provider-connections.ts";

function definition(api: CustomProviderDefinition["api"] = "openai-completions"): CustomProviderDefinition {
	return { id: "custom-local", name: "Local proxy", api, baseUrl: "http://127.0.0.1:8317/v1", keyless: false,
		models: [{ id: "test-model", name: "Test", contextWindow: 4096, maxTokens: 256, input: ["text", "image"], reasoning: false }] };
}

describe("subscription provider isolation", () => {
	it("exposes the native SDK subscription flows under distinct IDs, with no API-key handler", () => {
		const originals = builtinProviders();
		const aliases = subscriptionAliases(originals);
		assert.deepEqual(aliases.map((p) => p.id), ["subscription-openai-codex", "subscription-anthropic", "subscription-xai"]);
		for (const provider of aliases) {
			assert.equal(provider.auth.apiKey, undefined);
			assert.ok(provider.auth.oauth?.isSubscription);
			assert.ok(provider.getModels().length > 0);
			assert.ok(provider.getModels().every((m) => m.provider === provider.id && m.name.endsWith("· subscription")));
		}
	});
	it("API keys and another provider's stored credential cannot authenticate a subscription alias", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "not-a-subscription" }));
		const models = createModels({ credentials, authContext: { env: async () => "ambient-api-key", fileExists: async () => false } });
		for (const provider of subscriptionAliases(builtinProviders())) {
			models.setProvider(provider);
			assert.equal(await models.getAuth(provider.id), undefined);
		}
	});
	it("failed OAuth refresh never falls back to an ambient key", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("subscription-anthropic", async () => ({ type: "oauth", access: "expired", refresh: "refresh", expires: 0 }));
		let ambientReads = 0;
		const models = createModels({ credentials, authContext: { env: async () => { ambientReads++; return "paid-key"; }, fileExists: async () => false } });
		const original = subscriptionAliases(builtinProviders()).find((p) => p.id === "subscription-anthropic")!;
		const provider: Provider = { ...original, auth: { oauth: { ...original.auth.oauth!, refresh: async () => { throw new Error("revoked"); } } } };
		models.setProvider(provider);
		await assert.rejects(models.getAuth(provider.id), /OAuth refresh failed/);
		assert.equal(ambientReads, 0);
	});
});

describe("custom endpoint auth and transport", () => {
	it("uses the dedicated key through real SDK completions streaming, with redirect rejection", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("custom-local", async () => ({ type: "api_key", key: "dedicated-fixture-key", env: { LH_CUSTOM_PROVIDER_BASE_URL: definition().baseUrl, LH_CUSTOM_PROVIDER_API: definition().api } }));
		const models = createModels({ credentials });
		models.setProvider(customProvider(definition()));
		let calls = 0;
		const transport: typeof fetch = async (input, init) => {
			calls++;
			const req = new Request(input, init);
			assert.equal(new URL(req.url).origin, "http://127.0.0.1:8317");
			assert.equal(req.headers.get("authorization"), "Bearer dedicated-fixture-key");
			assert.equal(req.headers.get("openai-organization"), null);
			assert.equal(req.headers.get("openai-project"), null);
			assert.equal(init?.redirect, "error");
			const body = await req.json() as { model: string; messages: unknown[] };
			assert.equal(body.model, "test-model");
			assert.ok(body.messages.length > 0);
			return new Response('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
		};
		const result = await models.completeSimple(models.getModel("custom-local", "test-model")!, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, { fetch: transport });
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.provider, "custom-local");
		assert.equal(result.content.filter((p) => p.type === "text").map((p) => p.text).join(""), "OK");
		assert.equal(calls, 1);
	});
	it("does not borrow an ambient key when the dedicated key is missing", async () => {
		let ambientReads = 0;
		const models = createModels({ authContext: { env: async () => { ambientReads++; return "foreign-secret"; }, fileExists: async () => false } });
		models.setProvider(customProvider(definition()));
		assert.equal(await models.getAuth("custom-local"), undefined);
		assert.equal(ambientReads, 0);
	});
	it("refuses a key saved for a different endpoint or protocol", async () => {
		for (const env of [{ LH_CUSTOM_PROVIDER_BASE_URL: "https://different.example/v1", LH_CUSTOM_PROVIDER_API: "openai-completions" }, { LH_CUSTOM_PROVIDER_BASE_URL: definition().baseUrl, LH_CUSTOM_PROVIDER_API: "openai-responses" }]) {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("custom-local", async () => ({ type: "api_key", key: "never-send", env }));
			const models = createModels({ credentials });
			models.setProvider(customProvider(definition()));
			assert.equal(await models.getAuth("custom-local"), undefined);
		}
	});
	it("explicit keyless configuration works without exporting a key to the process environment", async () => {
		const models = createModels();
		models.setProvider(customProvider({ ...definition(), keyless: true }));
		assert.equal((await models.getAuth("custom-local"))?.source, "explicit keyless endpoint");
	});
	it("rejects cross-origin requests before invoking transport", async () => {
		let calls = 0;
		const transport: typeof fetch = async () => { calls++; return new Response(); };
		const guarded = endpointFetch("http://127.0.0.1:8317/v1", transport);
		await assert.rejects(guarded("https://other.example/v1/chat/completions"), /configured origin/);
		assert.equal(calls, 0);
	});
	it("removes ambient OpenAI account identifiers without removing the dedicated key", async () => {
		let seen = false;
		const fetcher = endpointFetch(definition().baseUrl, async (input) => {
			const req = input as Request;
			assert.equal(req.headers.get("openai-organization"), null);
			assert.equal(req.headers.get("openai-project"), null);
			assert.equal(req.headers.get("authorization"), "Bearer dedicated");
			seen = true;
			return new Response();
		});
		await fetcher(definition().baseUrl + "/chat/completions", { headers: { authorization: "Bearer dedicated", "OpenAI-Organization": "ambient-org", "OpenAI-Project": "ambient-project" } });
		assert.ok(seen);
	});
	it("registers the requested protocol without turning another protocol into a model alias", () => {
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
			const provider = customProvider(definition(api));
			assert.equal(provider.getModels()[0]!.api, api);
			assert.equal(provider.getModels()[0]!.baseUrl, definition().baseUrl);
		}
	});
});

it("Grok subscription preserves native xAI reasoning request fields and alias provenance", async () => {
	const credentials = new InMemoryCredentialStore();
	const provider = subscriptionAliases(builtinProviders()).find((p) => p.id === "subscription-xai")!;
	await credentials.modify(provider.id, async () => ({ type: "oauth", access: "grok-fixture-token", refresh: "fixture-refresh", expires: Date.now() + 3600000 }));
	const models = createModels({ credentials });
	models.setProvider(provider);
	const model = models.getModels(provider.id).find((m) => m.reasoning) ?? models.getModels(provider.id)[0]!;
	let calls = 0;
	const result = await models.completeSimple(model, { messages: [{ role: "user", content: "OK", timestamp: 1 }] }, { fetch: async (input, init) => {
		calls++;
		const req = new Request(input, init);
		assert.equal(new URL(req.url).origin, "https://api.x.ai");
		assert.equal(req.headers.get("authorization"), "Bearer grok-fixture-token");
		const body = await req.json() as { include: string[] };
		assert.ok(body.include.includes("reasoning.encrypted_content"));
		return new Response('data: {"type":"response.created","response":{"id":"response-test","status":"in_progress","model":"test","output":[]}}\n\ndata: {"type":"response.completed","response":{"id":"response-test","status":"completed","model":"test","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n', { headers: { "content-type": "text/event-stream" } });
	} });
	assert.equal(calls, 1);
	assert.equal(result.provider, "subscription-xai");
	assert.equal(result.stopReason, "stop", result.errorMessage);
});

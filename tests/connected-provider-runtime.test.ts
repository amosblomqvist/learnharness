import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, InMemoryCredentialStore, normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { subscriptionAliases } from "../src/agent/connected-providers.ts";

describe("subscription provider isolation", () => {
	it("exposes the native SDK subscription flows under distinct IDs, with no API-key handler", () => {
		const originals = builtinProviders();
		const aliases = subscriptionAliases(originals);
		assert.deepEqual(aliases.map((p) => p.id), ["subscription-openai-codex"]);
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
		await credentials.modify("subscription-openai-codex", async () => ({ type: "oauth", access: "expired", refresh: "refresh", expires: 0 }));
		let ambientReads = 0;
		const models = createModels({ credentials, authContext: { env: async () => { ambientReads++; return "paid-key"; }, fileExists: async () => false } });
		const original = subscriptionAliases(builtinProviders()).find((p) => p.id === "subscription-openai-codex")!;
		const provider: Provider = { ...original, auth: { oauth: { ...original.auth.oauth!, refresh: async () => { throw new Error("revoked"); } } } };
		models.setProvider(provider);
		await assert.rejects(models.getAuth(provider.id), /OAuth refresh failed/);
		assert.equal(ambientReads, 0);
	});
});


// Exercise the actual Codex adapter and the application's engine factory.
// Only HTTP responses and credentials are fixtures; no account or network is used.
import { zstdDecompressSync } from "node:zlib";
import { configureModelConnections, piEngineForSpec, piModels } from "../src/agent/models.ts";
import { Type } from "typebox";

const CODEX_ID = "subscription-openai-codex";
const accountId = "offline-account";
const access = "fixture." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url") + ".fixture";

async function codexFixture() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(CODEX_ID, async () => ({ type: "oauth", access, refresh: "offline-refresh", expires: Date.now() + 3_600_000 }));
	configureModelConnections({ credentials });
	const model = piModels().getModels(CODEX_ID)[0]!;
	assert.ok(model);
	return { credentials, model, engine: piEngineForSpec({ provider: CODEX_ID, id: model.id }) };
}

function responseEvents(events: unknown[]) {
	return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("real Codex adapter through the shared app engine (offline)", { concurrency: false }, () => {
	it("uses the subscription token and account header, supports tools and preserves the selected provider", async () => {
		const { model, engine } = await codexFixture();
		let calls = 0;
		const transport: typeof fetch = async (input, init) => {
			calls++;
			const request = new Request(input, init);
			assert.equal(new URL(request.url).origin, "https://chatgpt.com");
			assert.equal(request.headers.get("authorization"), "Bearer " + access);
			assert.equal(request.headers.get("chatgpt-account-id"), accountId);
			const bytes = Buffer.from(await request.arrayBuffer());
			const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
			assert.equal(body.model, model.id);
			const declared = [...(body.tools ?? []), ...body.input.flatMap((item: { tools?: { name?: string }[] }) => item.tools ?? [])];
			assert.ok(declared.some((tool: { name?: string }) => tool.name === "offline_tool"));
			const item = { type: "function_call", id: "fc_offline", call_id: "call_offline", name: "offline_tool", arguments: '{"value":"OK"}', status: "completed" };
			return responseEvents([
				{ type: "response.created", response: { id: "resp_offline", status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
				{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: "resp_offline", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
			]);
		};
		const result = await engine.streamFn(model, normalizeContext({ messages: [{ role: "user", content: "Offline tool check", timestamp: 1 }], tools: [{ name: "offline_tool", description: "Offline fixture", parameters: Type.Object({ value: Type.String() }) }] }), { fetch: transport, transport: "sse", apiKey: "must-not-override-subscription" }).result();
		assert.equal(calls, 1);
		assert.equal(result.provider, CODEX_ID);
		assert.equal(result.stopReason, "toolUse", result.errorMessage);
		const tool = result.content.find((part) => part.type === "toolCall");
		assert.ok(tool?.type === "toolCall");
		assert.equal(tool.name, "offline_tool");
		assert.deepEqual(tool.arguments, { value: "OK" });
	});

	it("reports provider rejection once without retrying or switching to API-key access", async () => {
		const { model, engine } = await codexFixture();
		let calls = 0;
		const result = await engine.streamFn(model, normalizeContext({ messages: [{ role: "user", content: "Offline rejection", timestamp: 1 }] }), { transport: "sse", fetch: async () => { calls++; return new Response('{"error":{"message":"offline rejected"}}', { status: 401 }); } }).result();
		assert.equal(calls, 1);
		assert.equal(result.stopReason, "error");
		assert.equal(result.provider, CODEX_ID);
	});

	it("an engine created before disconnect cannot send another request with the removed credential", async () => {
		const { credentials, model, engine } = await codexFixture();
		await credentials.delete(CODEX_ID);
		let calls = 0;
		const result = await engine.streamFn(model, normalizeContext({ messages: [{ role: "user", content: "Offline disconnected", timestamp: 1 }] }), { transport: "sse", apiKey: "paid-fallback-must-not-be-used", fetch: async () => { calls++; throw new Error("network must not run"); } }).result();
		assert.equal(calls, 0);
		assert.equal(result.stopReason, "error");
	});
});


it("a resumed Codex turn preserves its encrypted reasoning and tool-call identities", async () => {
	const { model, engine } = await codexFixture();
	const reasoning = { id: "rs_offline", type: "reasoning", summary: [], encrypted_content: "offline-reasoning-signature" };
	const previous = { role: "assistant" as const, api: model.api, provider: CODEX_ID, model: model.id, content: [
		{ type: "thinking" as const, thinking: "", thinkingSignature: JSON.stringify(reasoning) },
		{ type: "toolCall" as const, id: "call_offline|fc_offline", name: "offline_tool", arguments: { value: "OK" } },
	], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" as const, timestamp: 2 };
	const context = normalizeContext({ messages: [
		{ role: "user", content: "Continue offline", timestamp: 1 }, previous,
		{ role: "toolResult", toolCallId: "call_offline|fc_offline", toolName: "offline_tool", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
	], tools: [{ name: "offline_tool", description: "Offline fixture", parameters: Type.Object({ value: Type.String() }) }] });
	const result = await engine.streamFn(model, context, { transport: "sse", fetch: async (input, init) => {
		const request = new Request(input, init);
		const bytes = Buffer.from(await request.arrayBuffer());
		const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
		assert.deepEqual(body.input.find((item: { type: string }) => item.type === "reasoning"), reasoning);
		const call = body.input.find((item: { type: string }) => item.type === "function_call");
		assert.equal(call.id, "fc_offline");
		assert.equal(call.call_id, "call_offline");
		assert.equal(body.input.find((item: { type: string }) => item.type === "function_call_output").call_id, call.call_id);
		const item = { type: "message", id: "msg_offline", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
		return responseEvents([
			{ type: "response.created", response: { id: "resp_continued", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_continued", status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
		]);
	} }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.provider, CODEX_ID);
	assert.ok(result.content.some((part) => part.type === "text" && part.text === "OK"));
	assert.equal(previous.provider, CODEX_ID, "request conversion must not mutate persisted history");
});

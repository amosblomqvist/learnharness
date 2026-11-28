import assert from "node:assert/strict";
import { test } from "node:test";
import { fastModeCompletionResult, mergeFastModeResults } from "../src/core/native-chat-speed.ts";
import { emit, SERVER_EVENT_TYPES } from "../src/core/events.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

function completion(tier?: unknown): unknown {
	return { type: "response.completed", response: { status: "completed", service_tier: tier } };
}

test("actual Fast outcome is derived only from a successful response.completed", () => {
	for (const tier of ["priority", "fast"]) assert.deepEqual(fastModeCompletionResult(completion(tier)), { outcome: "applied", servedTier: tier });
	for (const tier of ["default", "flex", "scale", "ultrafast"]) assert.deepEqual(fastModeCompletionResult(completion(tier)), { outcome: "not-applied", servedTier: tier });
	for (const tier of [undefined, null, true, 1, {}, [], "auto", "private-unknown-tier"]) assert.deepEqual(fastModeCompletionResult(completion(tier)), { outcome: "unconfirmed" });
	for (const raw of [null, [], "priority", { type: "response.created", response: { status: "completed", service_tier: "priority" } }, { type: "response.incomplete", response: { status: "incomplete", service_tier: "priority" } }, { type: "response.completed", response: { status: "failed", service_tier: "priority" } }, { type: "response.completed", response: { status: "completed", service_tier: "priority", error: { code: "failed" } } }]) assert.equal(fastModeCompletionResult(raw), undefined);
});

test("a later priority call cannot hide a downgrade or missing confirmation from this turn", () => {
	const applied = { outcome: "applied", servedTier: "priority" } as const;
	const unconfirmed = { outcome: "unconfirmed" } as const;
	const standard = { outcome: "not-applied", servedTier: "default" } as const;
	assert.deepEqual(mergeFastModeResults(undefined, applied), applied);
	assert.deepEqual(mergeFastModeResults(applied, unconfirmed), unconfirmed);
	assert.deepEqual(mergeFastModeResults(unconfirmed, applied), unconfirmed);
	assert.deepEqual(mergeFastModeResults(applied, standard), standard);
	assert.deepEqual(mergeFastModeResults(standard, applied), standard);
	assert.deepEqual(mergeFastModeResults(standard, unconfirmed), standard);
});

test("chat speed results have a runtime SSE subscription and retain exact chat/model identity", async () => {
	assert(SERVER_EVENT_TYPES.includes("chat-speed-result"));
	const response = eventsResponse();
	const reader = response.body!.getReader();
	const payload = { chatId: "chat-speed-fixture", model: { provider: "chatgpt", id: "gpt-6.1-sol" }, result: { outcome: "not-applied", servedTier: "default" } } as const;
	try {
		emit("chat-speed-result", payload);
		const { value } = await reader.read();
		const wire = new TextDecoder().decode(value);
		assert(wire.includes("event: chat-speed-result"));
		const line = wire.split("\n").find((entry) => entry.startsWith("data: "))!;
		assert.deepEqual(JSON.parse(line.slice(6)), payload);
	} finally {
		await reader.cancel();
	}
});

test("custom and other-provider operations never request or announce native OpenAI Fast", async () => {
	const { normalizeContext } = await import("@earendil-works/pi-ai");
	const { configureProviderSource, piEngineForSpec, piModels } = await import("../src/agent/models.ts");
	const models = piModels();
	const native = models.getProvider("openai")!;
	const base = models.getModel("openai", "gpt-6.1-sol")!;
	const reported: unknown[] = [];
	const requests: Record<string, unknown>[] = [];
	try {
		for (const provider of ["fast-fixture-custom", "fast-fixture-external"]) {
			const model = { ...base, provider, baseUrl: "https://fast-fixture.invalid/v1" };
			configureProviderSource({ sync() {}, isCustom: id => id === "fast-fixture-custom" });
			models.setProvider({ ...native, id: provider, getModels: () => [model], getAllModels: () => [model] });
			const engine = piEngineForSpec({ provider, id: model.id }, false, undefined, undefined, true, result => reported.push(result));
			const context = normalizeContext({ messages: [{ role: "user", content: "offline fixture", timestamp: 1 }] });
			const result = await engine.streamFn(engine.model, context, { apiKey: "sk-offline-fixture-only", maxRetries: 0, fetch: async (input, init) => {
				const request = new Request(input, init);
				assert.equal(request.url, "https://fast-fixture.invalid/v1/responses");
				requests.push(JSON.parse(await request.text()));
				return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", service_tier: "priority", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
			} }).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
		}
		assert.equal(requests.length, 2);
		assert(requests.every(request => request.service_tier === undefined));
		assert.deepEqual(reported, []);
	} finally {
		configureProviderSource({ sync() {}, isCustom: () => false });
		models.deleteProvider("fast-fixture-custom");
		models.deleteProvider("fast-fixture-external");
	}
});

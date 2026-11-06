import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	compactionCutIndex,
	estimateContextTokens,
	estimateMessageTokens,
	estimateTokens,
	newCompactionMarker,
} from "../src/core/compaction.ts";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";

const model = { provider: "chatgpt", api: "openai-responses", id: "reasoning-fixture" } as Model<Api>;
const signed = (id: string, output = 8_000): LhMessage => ({
	id,
	role: "assistant",
	provider: model.provider,
	api: model.api,
	model: model.id,
	content: [
		{ type: "thinking", thinking: "", thinkingSignature: "opaque-a" },
		{ type: "thinking", thinking: "", thinkingSignature: "opaque-b" },
		{ type: "text", text: "answer" },
	],
	stopReason: "stop",
	usage: { input: 900_000, output, cacheRead: 0, cacheWrite: 0, totalTokens: 900_000 + output },
	timestamp: 1,
}) as LhMessage;

describe("reasoning-aware compaction estimates", () => {
	it("charges output once per replayable signed response, never input or total usage", () => {
		const message = signed("signed");
		const original = JSON.stringify(message);
		assert.equal(estimateMessageTokens(message, model), 8_000);
		assert.equal(estimateMessageTokens(message), 2, "without request identity, keep the text heuristic");
		assert.equal(JSON.stringify(message), original, "estimation preserves signatures and history");
	});

	it("does not let a smaller output reading reduce the readable-content estimate", () => {
		const message = signed("readable", 1);
		assert.equal(estimateMessageTokens(message, model), 2);
	});

	it("keeps existing estimates for foreign models, providers, APIs, and unsigned responses", () => {
		const message = signed("signed");
		for (const target of [
			{ ...model, id: "another-model" },
			{ ...model, provider: "openai" },
			{ ...model, api: "openai-completions" },
		]) {
			assert.equal(estimateMessageTokens(message, target), 2);
		}
		const unsigned = { ...message, content: [{ type: "text", text: "answer" }] } as LhMessage;
		assert.equal(estimateMessageTokens(unsigned, model), 2);
		const otherApi = { ...message, api: "anthropic-messages" } as LhMessage;
		assert.equal(estimateMessageTokens(otherApi, { ...model, api: "anthropic-messages" }), 2);
	});

	it("does not use missing, invalid, aborted, or errored output readings", () => {
		for (const output of [undefined, 0, -1, 0.5, NaN, Infinity, "8000"]) {
			const message = { ...signed("invalid"), usage: { output } } as unknown as LhMessage;
			assert.equal(estimateMessageTokens(message, model), 2);
		}
		for (const stopReason of ["error", "aborted"]) {
			assert.equal(estimateMessageTokens({ ...signed(stopReason), stopReason } as LhMessage, model), 2);
		}
	});

	it("advances the cut for reasoning-heavy history and preserves a pending question", () => {
		const pending = {
			...signed("pending", 10_000),
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-pending" },
				{ type: "toolCall", id: "question", name: "quiz", arguments: { question: "Q?" } },
			],
		} as LhMessage;
		const messages = [signed("old-1", 10_000), signed("old-2", 10_000), pending];
		assert.equal(compactionCutIndex(messages), 0, "the old heuristic cannot see the reasoning");
		const cut = compactionCutIndex(messages, 20_000, model);
		assert.equal(cut, 1);
		assert.equal(estimateTokens(messages.slice(cut), model), 20_000);
		assert.equal(messages.at(-1), pending);
		const marker = newCompactionMarker("Earlier work", {
			firstKeptMessageId: messages[cut]!.id,
			tokensBefore: 150_000,
			at: "fixture",
		});
		const projected = toLlmMessages([...messages, marker]);
		assert.ok(projected.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === "question")));
		assert.ok(!projected.some((m) => "id" in m && m.id === "old-1"));
	});

	it("counts retained reasoning when a compaction invalidates the provider usage anchor", () => {
		const kept = signed("kept", 8_000);
		const marker = newCompactionMarker("Earlier work", {
			firstKeptMessageId: kept.id, tokensBefore: 150_000, at: "fixture",
		});
		const messages = [signed("old", 100_000), kept, marker];
		assert.equal(estimateContextTokens(messages, model).lastUsageIndex, null);
		const projection = toLlmMessages(messages);
		assert.equal(estimateTokens(projection, model), estimateTokens(projection) - 2 + 8_000);
	});

	it("keeps an oversized newest assistant/tool group rather than orphaning its result", () => {
		const pending = {
			...signed("pending", 100_000),
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "opaque" },
				{ type: "toolCall", id: "question", name: "quiz", arguments: {} },
			],
		} as LhMessage;
		const result = {
			id: "result", role: "toolResult", toolCallId: "question", toolName: "quiz",
			content: [{ type: "text", text: "answer" }], isError: false, timestamp: 2,
		} as LhMessage;
		const messages = [signed("old"), pending, result];
		assert.equal(compactionCutIndex(messages, 20_000, model), 1);
		assert.ok(estimateTokens(messages.slice(1), model) > 20_000, "the budget remains a soft group boundary");
	});
});

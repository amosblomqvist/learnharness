import assert from "node:assert/strict";
import { test } from "node:test";
import { callCacheSavings, sessionCost } from "../src/server/pricing.ts";
import type { ChatRecord, TurnUsage } from "../src/core/contracts.ts";

function turn(overrides: Partial<TurnUsage> = {}): TurnUsage {
	return {
		id: "turn-1",
		messageId: "msg-1",
		at: "2026-10-25T00:00:00.000Z",
		model: "deepseek:deepseek-v4-pro",
		steps: [
			{
				inputTokens: 1_000_000,
				outputTokens: 0,
				cacheReadTokens: 1_000_000,
				cacheWriteTokens: 0,
				cacheWrite1hTokens: 0,
				reasoningTokens: 0,
			},
		],
		...overrides,
	};
}

test("callCacheSavings prices the DeepSeek prefix-cache discount from the catalog", () => {
	// deepseek-v4-pro: input $1.32/M, cache read $0.044/M → 1M reused tokens
	// avoid $1.276.
	const saved = callCacheSavings(turn().steps[0]!, turn().model);
	assert.ok(saved !== null);
	assert.ok(Math.abs(saved! - 1.276) < 1e-9, `expected 1.276, got ${saved}`);
});

test("callCacheSavings is 0 without reuse and null when unpriced", () => {
	const noReuse = callCacheSavings(
		{ inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
		"deepseek:deepseek-v4-pro",
	);
	assert.equal(noReuse, 0);
	assert.equal(callCacheSavings({ inputTokens: 10_000, outputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: 0 }, "unknown:model"), null);
});

test("sessionCost carries the provider-reported cache fold", () => {
	const chat = { turns: [turn()] } as unknown as Pick<ChatRecord, "turns">;
	const pricing = sessionCost(chat);
	assert.ok(pricing.cache);
	assert.equal(pricing.cache!.promptTokens, 2_000_000);
	assert.equal(pricing.cache!.cacheReadTokens, 1_000_000);
	assert.equal(pricing.cache!.hitRate, 0.5);
	assert.ok(pricing.cache!.savedUsd > 1.27);
	assert.equal(pricing.cache!.unpricedCalls, 0);
});

test("sessionCache keeps token truth when the rate table cannot price a call", () => {
	const chat = { turns: [turn({ model: "unknown:model" })] } as unknown as Pick<ChatRecord, "turns">;
	const pricing = sessionCost(chat);
	assert.ok(pricing.cache);
	assert.equal(pricing.cache!.hitRate, 0.5);
	assert.equal(pricing.cache!.unpricedCalls, 1);
	assert.equal(pricing.cache!.savedUsd, 0);
});

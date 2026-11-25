import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionCacheHitRate } from "../src/core/prices.ts";
import type { CallUsage, TurnUsage } from "../src/core/contracts.ts";

const step = (over: Partial<CallUsage> = {}): CallUsage => ({
	inputTokens: 100, outputTokens: 50, cacheReadTokens: 0,
	cacheWriteTokens: 0, reasoningTokens: 20, ...over,
});
const turn = (steps: CallUsage[], model = "fixture:model"): TurnUsage => ({
	id: "turn", messageId: "message", at: "2026-10-30T00:00:00Z", model, steps,
});

test("session cache hit rate weights every call by input tokens, not call percentages", () => {
	const turns = [
		turn([step({ inputTokens: 10, cacheReadTokens: 90 }), step({ inputTokens: 900 })]),
		turn([step({ inputTokens: 100, cacheReadTokens: 900 })], "unknown:unpriced"),
	];
	const before = structuredClone(turns);
	assert.equal(sessionCacheHitRate({ turns }), 990 / 2000);
	assert.deepEqual(turns, before, "the derived metric never mutates saved usage");
});

test("cache writes count once; output, reasoning and the one-hour subset do not inflate the denominator", () => {
	const turns = [turn([step({ inputTokens: 100, cacheReadTokens: 600,
		cacheWriteTokens: 300, cacheWrite1hTokens: 200, outputTokens: 50_000, reasoningTokens: 40_000 })])];
	assert.equal(sessionCacheHitRate({ turns }), 0.6);
	assert.equal(sessionCacheHitRate({ turns: [turn([step({ inputTokens: 0, cacheReadTokens: 100 })])] }), 1);
});

test("no recorded cache reads means hidden, not a fabricated zero-percent rate", () => {
	assert.equal(sessionCacheHitRate({}), null);
	assert.equal(sessionCacheHitRate({ turns: [] }), null);
	assert.equal(sessionCacheHitRate({ turns: [turn([])] }), null);
	for (const usage of [
		step({ cacheReadTokens: undefined, cacheWriteTokens: undefined }),
		step(), step({ cacheWriteTokens: 100 }), step({ inputTokens: 0 }),
	]) assert.equal(sessionCacheHitRate({ turns: [turn([usage])] }), null);
});

test("missing historical cache buckets contribute no recorded reuse, without requiring pricing or a catalog model", () => {
	assert.equal(sessionCacheHitRate({ turns: [
		turn([step({ inputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined })]),
		turn([step({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: undefined })], "claude-code:opus"),
	] }), 0.5);
});

test("missing required input, invalid counts and overflow never produce a displayed rate", () => {
	const valid = step({ cacheReadTokens: 100 });
	assert.equal(sessionCacheHitRate({ turns: [turn([valid, step({ inputTokens: undefined })])] }), null);
	for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
		for (const value of [-1, NaN, Infinity]) {
			assert.equal(sessionCacheHitRate({ turns: [turn([valid, step({ [field]: value })])] }), null);
		}
	}
	assert.equal(sessionCacheHitRate({ turns: [turn([step({ inputTokens: Number.MAX_VALUE, cacheReadTokens: Number.MAX_VALUE })])] }), null);
});

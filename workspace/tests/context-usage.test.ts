import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { measuredContextTokens, newCompactionMarker, type LhMessage } from "../src/core/index.ts";
import { SessionModel } from "../components/session-core.ts";

function assistant(id: string, stopReason: AssistantMessage["stopReason"] = "stop", total = 999_999): LhMessage {
	return { id, role: "assistant", content: [{ type: "text", text: "fixture" }], api: "openai-completions", provider: "openrouter", model: "fixture", stopReason, timestamp: 1,
		usage: { input: 10_000, output: 1_000, cacheRead: 70_000, cacheWrite: 2_000, reasoning: 500, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as LhMessage;
}
const marker = () => newCompactionMarker("educational summary", { firstKeptMessageId: "old", tokensBefore: 110_001, at: "fixture" });

test("meter sums four disjoint fields, ignoring reasoning subset and totalTokens overrides", () => {
	assert.equal(measuredContextTokens([assistant("old")]), 83_000);
	assert.equal(measuredContextTokens([]), null);
	for (const stop of ["stop", "length", "toolUse"] as const) assert.equal(measuredContextTokens([assistant("a", stop)]), 83_000);
});

test("newest marker invalidates retained pre-cut usage; summarizer money log cannot supply a measurement", () => {
	const old = assistant("old");
	assert.equal(measuredContextTokens([old, marker()]), null);
	assert.equal(measuredContextTokens([old, marker(), assistant("fresh")]), 83_000);
	assert.equal(measuredContextTokens([old, marker(), assistant("fresh"), marker()]), null);
	// The summarizer is logged as a money-channel turn, never an assistant
	// in the native conversation list. No money-channel input exists here.
});

test("errors, aborts, all-zero/invalid usage and unfinished slots preserve the previous valid reading", () => {
	const old = assistant("old");
	for (const stop of ["error", "aborted"] as const) assert.equal(measuredContextTokens([old, assistant("bad", stop)]), 83_000);
	const zero = assistant("zero") as AssistantMessage & { id: string };
	zero.usage = { ...zero.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.equal(measuredContextTokens([old, zero]), 83_000);
	assert.equal(measuredContextTokens([zero]), null);
	assert.equal(measuredContextTokens([old, assistant("partial")], new Set(["partial"])), 83_000);
	assert.equal(measuredContextTokens([marker(), assistant("bad", "error")]), null);
});

test("live terminal-looking message_update is not completion; each message_end updates immediately", () => {
	const model = new SessionModel({ chatId: "fixture", initialMessages: [assistant("old")] });
	const fresh = assistant("live") as AssistantMessage & { id: string };
	fresh.usage = { ...fresh.usage, input: 20_000 };
	model.applyWireEvent({ type: "message_start", message: fresh });
	model.applyWireEvent({ type: "message_update", message: fresh });
	assert.equal(model.getState().contextTokens, 83_000);
	model.applyWireEvent({ type: "message_end", message: fresh });
	assert.equal(model.getState().contextTokens, 93_000);
	model.applyWireEvent({ type: "message_start", message: assistant("next") });
	assert.equal(model.getState().contextTokens, 93_000);
	model.applyWireEvent({ type: "message_end", message: assistant("next", "toolUse") });
	assert.equal(model.getState().contextTokens, 83_000);
	model.setMessages([assistant("old"), marker()]);
	assert.equal(model.getState().contextTokens, null);
});

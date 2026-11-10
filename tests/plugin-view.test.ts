import assert from "node:assert/strict";
import { test } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const call: LhMessage = {
	id: "assistant_plugin", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
	content: [{ type: "toolCall", id: "call_plugin", name: "example_echo", arguments: { text: "Hello" } }],
	stopReason: "toolUse", timestamp: 1,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const result: LhMessage = {
	id: "result_plugin", role: "toolResult", toolCallId: "call_plugin", toolName: "example_echo",
	content: [{ type: "text", text: "The native result" }], details: null, isError: false, timestamp: 2,
};
const toolPart = (messages: LhMessage[]) => projectView(messages).flatMap(message => message.parts).find(part => part.toolCallId === "call_plugin")!;

test("plugin tool projection retains native content even when details is null", () => {
	const part = toolPart([call, result]);
	assert.equal(part.state, "output-available");
	assert.equal(part.output, null);
	assert.deepEqual(part.result, { content: result.content, details: null, isError: false });
	assert.equal(JSON.stringify([call, result]).includes('"result":'), false, "projection does not alter persisted messages");
});

test("plugin tool projection retains native error data without changing existing error presentation", () => {
	const part = toolPart([call, { ...result, isError: true } as LhMessage]);
	assert.equal(part.state, "output-error");
	assert.equal(part.errorText, "The native result");
	assert.deepEqual(part.rawInput, { text: "Hello" });
	assert.equal(part.result?.isError, true);
});

test("live and settled plugin tool projection expose the same native result", () => {
	const nativeResult = { content: result.content, details: null, isError: false };
	const live = projectView([call], {
		inFlight: true, streamingIds: new Set([call.id]),
		executions: new Map([["call_plugin", { isError: false, output: null, result: nativeResult }]]),
	}).flatMap(message => message.parts).find(part => part.toolCallId === "call_plugin")!;
	assert.equal(live.state, "output-available");
	assert.deepEqual(live.result, toolPart([call, result]).result);
});

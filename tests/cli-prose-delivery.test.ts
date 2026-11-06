/** Claude Code CLI prose delivery: synthetic fixtures only; no provider calls. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNarrationBlock, makeNarrationGuard, NARRATION_BLOCK_REASON } from "../src/agent/narration-guard.ts";
import { failedOutputCallIds, userFacingTextOf } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const LESSON = "A complete synthetic explanation.";
const send = (message: unknown = LESSON, id = "s") => ({ type: "toolCall", id, name: "send_to_user", arguments: { message } });
const quiz = { type: "toolCall", id: "q", name: "quiz", arguments: {} };
const text = (t: string) => ({ type: "text", text: t });
const narration = { type: "thinking", thinking: "Summary of the prose." };
const reasoning = { type: "thinking", thinking: "" };
const assistant = (content: unknown[], provider = "claude-code", stopReason = "toolUse") =>
	({ id: "a1", role: "assistant", provider, stopReason, content }) as never;
const texts = (...content: unknown[]) =>
	projectView([assistant(content)])[0]!.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
const ask = (m: never) => makeNarrationGuard().beforeToolCall!({ assistantMessage: m, toolCall: quiz } as never);

describe("narration detection on the signature-free CLI path", () => {
	it("treats non-empty thinking as narration only for claude-code", () => {
		assert.equal(isNarrationBlock(narration, "claude-code"), true);
		assert.equal(isNarrationBlock(narration, "anthropic"), false);
		assert.equal(isNarrationBlock(narration), false);
	});
	it("leaves empty reasoning and non-thinking blocks alone", () => {
		assert.equal(isNarrationBlock(reasoning, "claude-code"), false);
		assert.equal(isNarrationBlock({ type: "thinking", thinking: "  \n" }, "claude-code"), false);
		assert.equal(isNarrationBlock(text("x"), "claude-code"), false);
	});
	it("blocks a question whose prose became narration", async () => {
		assert.deepEqual(await ask(assistant([narration, quiz])), { block: true, reason: NARRATION_BLOCK_REASON });
	});
	it("passes a bare question, visible text, and other providers", async () => {
		assert.equal(await ask(assistant([reasoning, quiz])), undefined);
		assert.equal(await ask(assistant([narration, text(LESSON), quiz])), undefined);
		assert.equal(await ask(assistant([narration, quiz], "anthropic")), undefined);
	});
});

describe("one message when text repeats send_to_user", () => {
	const echoed = `${LESSON}\n\n[tool call: mcp__learnharness__quiz]`;
	it("renders once in either order", () => {
		assert.deepEqual(texts(text(LESSON), send(), quiz), [LESSON]);
		assert.deepEqual(texts(send(), text(LESSON), quiz), [LESSON]);
	});
	it("drops the typed tool-call line", () => {
		assert.deepEqual(texts(text(echoed), send(), quiz), [LESSON]);
		assert.deepEqual(userFacingTextOf([text(echoed), send()]), [LESSON]);
	});
	it("matches a copy that lost a LaTeX backslash, keeping the send_to_user copy", () => {
		assert.deepEqual(texts(text("Compute $7 times 6$."), send("Compute $7 \\times 6$.")), ["Compute $7 \\times 6$."]);
	});
	it("does not flash a partial streaming copy", () => {
		assert.deepEqual(texts(text(LESSON), send("A complete")), [LESSON]);
	});
	it("keeps different prose, and text beside a failed send", () => {
		assert.deepEqual(texts(text("Intro."), send(), quiz), ["Intro.", LESSON]);
		const failed = assistant([text(LESSON), send()]);
		const result = { id: "r1", role: "toolResult", toolCallId: "s", toolName: "send_to_user", isError: true, content: [text("failed")] } as never;
		const view = projectView([failed, result])[0]!.parts.filter((p) => p.type === "text");
		assert.equal(view.length, 1);
		assert.deepEqual(userFacingTextOf([text(LESSON), send()], failedOutputCallIds([failed, result])), [LESSON]);
	});
	it("counts one block for coverage", () => {
		assert.deepEqual(userFacingTextOf([text(LESSON), send()]), [LESSON]);
		assert.deepEqual(userFacingTextOf([text("Intro."), send()]), ["Intro.", LESSON]);
	});
});

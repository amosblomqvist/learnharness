/** Narration guard: synthetic fixtures only; no provider calls or captures. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUESTION_TOOLS } from "../src/core/pending.ts";
import {
	isNarrationBlock, makeNarrationGuard, narrationGuardApplies, NARRATION_BLOCK_REASON,
	NARRATION_GUARD_MAX_BLOCKS, SEND_TO_USER_DELIVERY_RULE,
} from "../src/agent/narration-guard.ts";
import { sendToUserApplies } from "../src/agent/tools/send-to-user.ts";

// A synthetic signature with the proposed marker in the opaque header.
// This fixture exercises the heuristic, not a documented provider format.
const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");
const thinking = (type: string) => ({ type: "thinking", thinking: "", thinkingSignature: sig(type) });
const quiz = { type: "toolCall", id: "t1", name: "quiz", arguments: {} };
const output = (message: unknown = "A complete synthetic explanation.") => ({
	type: "toolCall", id: "s", name: "send_to_user", arguments: { message },
});
const msg = (...content: unknown[]) => ({ role: "assistant", content }) as never;
const ask = (g: ReturnType<typeof makeNarrationGuard>, m: never, name = "quiz") =>
	g.beforeToolCall!({ assistantMessage: m, toolCall: { ...quiz, name } } as never);
const delivered = (g: ReturnType<typeof makeNarrationGuard>, m: never, call = output(), isError = false, resultError = isError) =>
	g.afterToolCall!({ assistantMessage: m, toolCall: call, isError, result: { isError: resultError } } as never);

describe("narrationGuardApplies", () => {
	for (const [provider, id, enabled] of [
		["anthropic", "claude-sonnet-5-5", true],
		["anthropic", "claude-haiku-5-5", true],
		["openrouter", "anthropic/claude-opus-5.5", true],
		["amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0", true],
		["fixture", "CLAUDE-fixture", true],
		["claude-code", "opus", true],
		["openai", "gpt-4o-mini", false],
		["anthropic", "opaque-alias", false],
	] as const) {
		it(`${provider}/${id}: shares the tool's gate, with teacher-only enforcement`, () => {
			const model = { provider, id };
			for (const kind of ["teacher", "prober", "practice"]) {
				assert.equal(sendToUserApplies(kind, model, false), enabled && kind !== "practice");
				assert.equal(narrationGuardApplies(kind, model, false), enabled && kind === "teacher");
				assert.equal(sendToUserApplies(kind, model, true), false);
				assert.equal(narrationGuardApplies(kind, model, true), false);
			}
		});
	}
	it("pins the approved delivery and retry wording", () => {
		assert.equal(SEND_TO_USER_DELIVERY_RULE, "## Delivering your prose\n\nDeliver learner-facing prose through `send_to_user`; ordinary response text may be converted into summarized thinking instead of reaching the learner. Send the complete explanation, example, or commentary before calling the accompanying question tool. Question-only turns do not require an extra message. A question whose response contains narration but no delivered prose may be rejected so you can deliver the missing explanation and retry.");
		assert.equal(NARRATION_BLOCK_REASON, "This response contains narration but no delivered learner-facing prose. Write the explanation or commentary the learner needs through `send_to_user`, then retry this question. Deliver learner-facing content, not internal reasoning.");
	});
});

describe("isNarrationBlock", () => {
	it("only recognizes the marker in a thinking signature's first 60 decoded bytes", () => {
		assert.equal(isNarrationBlock(thinking("narration")), true);
		for (const block of [
			thinking("thinking"),
			{ type: "thinking" },
			{ type: "thinking", thinkingSignature: "%%%" },
			{ type: "text", thinkingSignature: sig("narration") },
			{ type: "thinking", thinkingSignature: Buffer.from("x".repeat(60) + "narration").toString("base64") },
		]) assert.equal(isNarrationBlock(block), false);
	});
});

describe("makeNarrationGuard", () => {
	for (const name of QUESTION_TOOLS) {
		it(`blocks ${name} when narration has no learner-facing delivery`, async () => {
			const r = await ask(makeNarrationGuard(), msg(thinking("thinking"), thinking("narration"), quiz), name);
			assert.equal(r?.block, true);
			assert.equal(r?.reason, NARRATION_BLOCK_REASON);
		});
	}
	it("allows ordinary text, plain thinking, and legitimate question-only turns", async () => {
		const g = makeNarrationGuard();
		assert.equal(await ask(g, msg(thinking("narration"), { type: "text", text: "Hello" }, quiz)), undefined);
		assert.equal(await ask(g, msg(thinking("thinking"), quiz)), undefined);
		assert.equal(await ask(g, msg(quiz)), undefined);
	});
	it("does not treat blank ordinary text as delivered prose", async () => {
		assert.equal((await ask(makeNarrationGuard(), msg(thinking("narration"), { type: "text", text: " \n " }, quiz)))?.block, true);
	});
	it("requires successful output execution, not mere call presence", async () => {
		const g = makeNarrationGuard();
		const m = msg(thinking("narration"), output(), quiz);
		assert.equal((await ask(g, m))?.block, true, "a pending or later output call is not delivery");
		await delivered(g, m);
		assert.equal(await ask(g, m), undefined);
	});
	for (const [isError, resultError] of [[true, true], [true, false], [false, true]]) {
		it(`does not credit failed output (${isError}/${resultError})`, async () => {
			const g = makeNarrationGuard();
			const m = msg(thinking("narration"), output(), quiz);
			await delivered(g, m, output(), isError, resultError);
			assert.equal((await ask(g, m))?.block, true);
		});
	}
	for (const value of ["", " \n\t", 42, null]) {
		it(`does not credit unusable output ${JSON.stringify(value)}`, async () => {
			const g = makeNarrationGuard();
			const m = msg(thinking("narration"), output(value), quiz);
			await delivered(g, m, output(value));
			assert.equal((await ask(g, m))?.block, true);
		});
	}
	it("does not credit successful delivery from another assistant response", async () => {
		const g = makeNarrationGuard();
		await delivered(g, msg(output()));
		assert.equal((await ask(g, msg(thinking("narration"), quiz)))?.block, true);
	});
	it("ignores non-question tools without consuming the block budget", async () => {
		const g = makeNarrationGuard();
		const m = msg(thinking("narration"), quiz);
		assert.equal(await ask(g, m, "read"), undefined);
		for (let i = 0; i < NARRATION_GUARD_MAX_BLOCKS; i++) assert.equal((await ask(g, m))?.block, true);
		assert.equal(await ask(g, m), undefined);
	});
	it("counts blocks across responses in one run, but resets for a new agent run", async () => {
		const g = makeNarrationGuard();
		for (let i = 0; i < NARRATION_GUARD_MAX_BLOCKS; i++) {
			assert.equal((await ask(g, msg(thinking("narration"), quiz)))?.block, true);
		}
		assert.equal(await ask(g, msg(thinking("narration"), quiz)), undefined);
		assert.equal((await ask(makeNarrationGuard(), msg(thinking("narration"), quiz)))?.block, true);
	});
});

/** Narration guard: synthetic fixtures only. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	makeNarrationGuard, narrationGuardApplies, NARRATION_GUARD_MAX_BLOCKS, SEND_TO_USER_DELIVERY_RULE,
} from "../src/agent/narration-guard.ts";

// Anthropic's signatures are base64 protobuf; the block type string sits in the header.
const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");
const thinking = (type: string) => ({ type: "thinking", thinking: "", thinkingSignature: sig(type) });
const quiz = { type: "toolCall", id: "t1", name: "quiz", arguments: {} };
const msg = (...content: unknown[]) => ({ role: "assistant", content }) as never;
const ask = (g: ReturnType<typeof makeNarrationGuard>, m: never, name = "quiz") =>
	g({ assistantMessage: m, toolCall: { name } });

describe("narrationGuardApplies", () => {
	it("applies to the teacher on the Anthropic API with the default registry", () => {
		assert.equal(narrationGuardApplies("teacher", { provider: "anthropic" }, false), true);
	});
	it("does not apply to other providers, agents, or explicit tool registries", () => {
		assert.equal(narrationGuardApplies("teacher", { provider: "openrouter" }, false), false);
		assert.equal(narrationGuardApplies("teacher", { provider: "openai" }, false), false);
		assert.equal(narrationGuardApplies("prober", { provider: "anthropic" }, false), false);
		assert.equal(narrationGuardApplies("practice", { provider: "anthropic" }, false), false);
		assert.equal(narrationGuardApplies("teacher", { provider: "anthropic" }, true), false);
	});
	it("ships a rule that names the tool", () => {
		assert.match(SEND_TO_USER_DELIVERY_RULE, /send_to_user/);
	});
});

describe("makeNarrationGuard", () => {
	it("blocks a question whose prose became a narration block", async () => {
		const r = await ask(makeNarrationGuard(), msg(thinking("thinking"), thinking("narration"), quiz));
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /send_to_user/);
	});
	it("lets through text, send_to_user, or plain thinking", async () => {
		const g = makeNarrationGuard();
		assert.equal(await ask(g, msg(thinking("thinking"), thinking("narration"), { type: "text", text: "Hello" }, quiz)), undefined);
		assert.equal(await ask(g, msg(thinking("narration"), { type: "toolCall", id: "s", name: "send_to_user", arguments: { message: "x" } }, quiz)), undefined);
		assert.equal(await ask(g, msg(thinking("thinking"), quiz)), undefined);
	});
	it("ignores non-question tools", async () => {
		assert.equal(await ask(makeNarrationGuard(), msg(thinking("narration"), quiz), "read"), undefined);
	});
	it("stands down after the block budget so a stubborn model cannot loop", async () => {
		const g = makeNarrationGuard();
		const m = msg(thinking("narration"), quiz);
		for (let i = 0; i < NARRATION_GUARD_MAX_BLOCKS; i++) assert.equal((await ask(g, m))?.block, true);
		assert.equal(await ask(g, m), undefined);
	});
});

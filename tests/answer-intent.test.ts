import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswerIntent, parseAnswerIntentRequest, type AnswerIntentRequest } from "../src/core/answer-intent.ts";
import { needsAnswerIntent, resolveAnswerIntent } from "../components/answer-intent.ts";
import type { QuestionData } from "../src/core/question-core.ts";

const single: AnswerIntentRequest = { question: "Q", mode: "single-select", options: ["A", "B", "C"], allowDontKnow: true, thinking: "it's B" };

test("model replies outside the contract read as unclear, never as a guessed pick", () => {
	assert.deepEqual(parseAnswerIntent('```json\n{"choice": [2]}\n```', single), { indices: [2] });
	assert.deepEqual(parseAnswerIntent('{"choice": [1, 3]}', single), { unclear: true }, "single-select needs exactly one");
	assert.deepEqual(parseAnswerIntent('{"choice": [1, 3, 3]}', { ...single, mode: "multi-select" }), { indices: [1, 3] });
	assert.deepEqual(parseAnswerIntent('{"choice": [4]}', single), { unclear: true }, "out of range");
	assert.deepEqual(parseAnswerIntent('{"choice": "dont_know"}', single), { dontKnow: true });
	assert.deepEqual(parseAnswerIntent('{"choice": "dont_know"}', { ...single, allowDontKnow: false }), { unclear: true });
	assert.deepEqual(parseAnswerIntent("B", single), { unclear: true });
	assert.deepEqual(parseAnswerIntent('{"choice": [true]}', single), { unclear: true }, "no coercion");
	assert.deepEqual(parseAnswerIntent('{"choice": [[2]]}', single), { unclear: true }, "no coercion");
	assert.throws(() => parseAnswerIntentRequest({ ...single, thinking: " " }));
});

test("a spoken pick maps to the option shown at that position, after shuffling", async () => {
	const question = { id: "q", kind: "quiz", question: "Q", mode: "single-select", createdAt: "",
		options: [{ label: "Shown first", value: "z" }, { label: "Shown second", value: "a" }] } as QuestionData;
	const req = { dontKnow: false, values: [], thinking: "the second one" };
	assert.equal(needsAnswerIntent(question, req), true);
	assert.equal(needsAnswerIntent(question, { ...req, values: ["z"] }), false, "a click wins");
	let sent: { options: string[]; allowDontKnow: boolean } | undefined;
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		sent = JSON.parse(init.body as string);
		return Response.json({ indices: [2] });
	}) as typeof fetch;
	try {
		assert.deepEqual((await resolveAnswerIntent(question, req)).values, ["a"]);
		assert.deepEqual(sent, { question: "Q", mode: "single-select", options: ["Shown first", "Shown second"], allowDontKnow: true, thinking: "the second one" });
		globalThis.fetch = (async () => Response.json({ unclear: true })) as unknown as typeof fetch;
		await assert.rejects(resolveAnswerIntent(question, req), /Pick one/);
	} finally {
		globalThis.fetch = original;
	}
});

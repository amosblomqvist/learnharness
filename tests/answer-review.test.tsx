import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LhMessage } from "../src/core/native-messages.ts";
import { answerReviewOf, learningModeOf, learningRequest, FEYNMAN_TAG } from "../src/core/answer-review.ts";
import { AnswerReviewActions } from "../components/answer-review.tsx";
import { sideThreadReducer } from "../components/use-side-thread.ts";

function fixture(tool = "probe", kind = "quiz"): LhMessage[] {
	return [
		{ id: "question", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "q1", name: tool, arguments: { question: "Why?" } }] },
		{ id: "answer", role: "toolResult", toolCallId: "q1", toolName: tool, details: { kind }, isError: false },
		{ id: "feedback", role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Feedback." }] },
	] as LhMessage[];
}
test("review waits for a completed tutor reaction and binds the answered question, not the next one", () => {
	const history = fixture();
	assert.equal(answerReviewOf(history.slice(0, 2)), undefined);
	history.push({ id: "next", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "q2", name: "probe", arguments: {} }] } as LhMessage);
	assert.deepEqual(answerReviewOf(history), { answerId: "answer", questionCallId: "q1", sourceMessageId: "question" });
});
test("all four builtin graded question tools support review; asks and dismissals do not", () => {
	for (const tool of ["quiz", "probe", "explain", "recall"]) assert(answerReviewOf(fixture(tool, ["explain", "recall"].includes(tool) ? "explain" : "quiz")));
	assert.equal(answerReviewOf(fixture("ask_user_question", "ask")), undefined);
	const dismissed = fixture(); Object.assign((dismissed[1] as { details: object }).details, { dismissed: true });
	assert.equal(answerReviewOf(dismissed), undefined);
});
test("failed or partial feedback, orphan results and newer user turns do not invent a completed review", () => {
	for (const reason of ["error", "aborted", "length", "pending"]) {
		const history = fixture(); Object.assign(history[2]!, { stopReason: reason });
		assert.equal(answerReviewOf(history), undefined);
	}
	assert.equal(answerReviewOf(fixture().slice(1)), undefined);
	assert.equal(answerReviewOf([...fixture(), { id: "user", role: "user", content: "Another topic" } as LhMessage]), undefined);
});
test("Feynman mode is explicit, durable in request text, and retry formatting is idempotent", () => {
	const tagged = learningRequest("My explanation", "feynman");
	assert.equal(tagged, `${FEYNMAN_TAG}\nMy explanation`);
	assert.equal(learningRequest(tagged, "feynman"), tagged);
	assert.equal(learningRequest("ordinary question"), "ordinary question");
	assert.equal(learningModeOf([{ role: "user", text: tagged }]), "feynman");
	assert.equal(learningModeOf([{ role: "user", text: tagged }, { role: "user", text: learningRequest("Why?", "clarify") }]), "clarify");
});
test("switching practice mode preserves the same side conversation and saved history", () => {
	const anchor = { kind: "composer" as const };
	const first = sideThreadReducer(null, { type: "open", segmentId: "question", anchor, learningMode: "feynman" })!;
	assert.equal(first.learningMode, "feynman");
	const direct = sideThreadReducer(first, { type: "open", segmentId: "question", anchor, learningMode: "clarify" })!;
	assert.equal(direct.threadId, first.threadId); assert.equal(direct.messages, first.messages);
	assert.equal(direct.learningMode, "clarify");
});
test("post-answer choices are explicit buttons and never submit the main answer form", () => {
	const html = renderToStaticMarkup(<AnswerReviewActions onClarify={() => {}} onFeynman={() => {}} onContinue={() => {}} />);
	for (const text of ["Ask about this answer", "Explain it to AI", "Continue to next question"]) assert(html.includes(text));
	assert.equal((html.match(/type="button"/g) ?? []).length, 3);
});

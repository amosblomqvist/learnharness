import assert from "node:assert/strict";
import test from "node:test";
import { restoreQuestionDraft, serializeQuestionDraft } from "../components/workspace/question-draft";

test("question form survives JSON persistence with its exact pending-question identity", () => {
	const draft = { readingThinking: "My reading notes", form: { selection: { selected: new Set([0, 2]), otherSelected: true, dontKnow: false }, thinking: "My reasoning", other: "Another answer", text: "Answer draft", confidenceIndex: 3 } };
	const saved = { questionId: '["question-call","message-id"]', text: serializeQuestionDraft(draft) };
	assert.deepEqual(restoreQuestionDraft(saved, saved.questionId), draft);
	assert.equal(restoreQuestionDraft(saved, "another-question"), undefined);
	assert.equal(restoreQuestionDraft(saved, undefined), undefined);
});

test("corrupt or invalid question draft does not enter the form", () => {
	for (const text of ["{", "null", "[]", '{"readingThinking":5}', '{"form":{"selection":{"selected":[-1]}}}']) {
		assert.equal(restoreQuestionDraft({ questionId: "pending", text }, "pending"), undefined);
	}
});

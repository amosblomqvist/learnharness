/**
 * What the dock reads aloud for a pending question (ElevenLabs voice slice 11):
 * the PROMPT only, in every question mode. Options, their labels and
 * descriptions, the quiz's explanation and committed answers are never spoken.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	markdownToSpeechChunks,
	questionPromptMarkdown,
	questionPromptSpeech,
	type QuestionData,
	type QuestionMode,
} from "../src/core/index.ts";

const OPTIONS = [
	{ label: "OPTION-ALPHA", value: "a", description: "DESC-ALPHA" },
	{ label: "OPTION-BETA", value: "b", description: "DESC-BETA" },
];

function questionOf(mode: QuestionMode, patch: Partial<QuestionData> = {}): QuestionData {
	return {
		id: "call-1",
		kind: mode === "text" ? "ask" : "quiz",
		question: "What is $x^2$ when $x = 3$?",
		mode,
		options: mode === "text" ? [] : OPTIONS,
		createdAt: "2026-10-29T00:00:00.000Z",
		...patch,
	};
}

describe("questionPromptSpeech", () => {
	for (const mode of ["single-select", "multi-select", "text"] as const) {
		it(`${mode}: speaks the prompt through the markdown pipeline and never an option`, () => {
			const chunks = questionPromptSpeech(questionOf(mode));
			assert.deepEqual(chunks, markdownToSpeechChunks("What is $x^2$ when $x = 3$?"));
			const spoken = chunks.join(" ");
			assert.match(spoken, /What is/);
			assert.doesNotMatch(spoken, /OPTION|DESC/);
		});
	}

	it("never speaks what the dock keeps hidden or secondary (explanation, committed answer, correct index)", () => {
		const quiz = questionOf("single-select", { kind: "quiz", explanation: "SECRET-EXPLANATION", correctIndices: [1] });
		const explain = questionOf("text", { kind: "explain", committedAnswer: "SECRET-COMMITMENT" });
		for (const q of [quiz, explain]) {
			assert.doesNotMatch(questionPromptSpeech(q).join(" "), /SECRET/);
		}
	});

	it("the details shown under the question are part of the prompt, after it", () => {
		const q = questionOf("text", { question: "Why?", context: "Answer in **one** sentence." });
		assert.equal(questionPromptMarkdown(q), "Why?\n\nAnswer in **one** sentence.");
		assert.deepEqual(questionPromptSpeech(q), markdownToSpeechChunks("Why?\n\nAnswer in **one** sentence."));
	});

	it("blank details add nothing", () => {
		assert.equal(questionPromptMarkdown(questionOf("text", { question: "Why?", context: "  " })), "Why?");
	});
});

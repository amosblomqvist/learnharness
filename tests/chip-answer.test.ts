/**
 * Chip-lane answering (owner round, 2026-11-19): the dock and the parked
 * chip build QuestionData through ONE canonical builder and grade through
 * ONE builder — these tests pin the consumer-visible seams that made the
 * two submit paths disagree before.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	answerRequestForText,
	buildAnswer,
	questionDataFor,
	type AskToolInput,
	type ExplainToolInput,
	type QuizToolInput,
} from "../src/core/question-core.ts";

function quizInput(extra: Partial<QuizToolInput> = {}): QuizToolInput {
	return {
		type: "check",
		nodeId: "node-1",
		question: "Which planet is smallest?",
		options: [
			{ label: "Mercury", value: "mercury" },
			{ label: "Mars", value: "mars" },
			{ label: "Venus", value: "venus" },
		],
		explanation: "Mercury is the smallest planet.",
		correctAnswer: "mercury",
		...extra,
	} as QuizToolInput;
}

test("the seeded builder grades the same answer identically on every build", () => {
	const first = questionDataFor("call-1", "quiz", quizInput());
	const second = questionDataFor("call-1", "quiz", quizInput());
	assert.deepEqual(first.options, second.options, "same call ⇒ same displayed order");
	assert.deepEqual(first.correctIndices, second.correctIndices);
	assert.equal(first.explanation, "Mercury is the smallest planet.");

	// Both paths start from the same canonical data; the chip resolves a
	// value from composer prose, the dock passes values directly.
	const chipAnswer = buildAnswer(first, answerRequestForText(second, "Mars"));
	const dockAnswer = buildAnswer(second, { values: ["mars"] });
	assert.equal(chipAnswer.correct, false);
	assert.equal(chipAnswer.correct, dockAnswer.correct, "chip and dock agree on a wrong pick");
	assert.equal(chipAnswer.correctIndices && chipAnswer.correctIndices.length, 1);

	const chipRight = buildAnswer(first, answerRequestForText(first, "mercury"));
	const dockRight = buildAnswer(first, { values: ["mercury"] });
	assert.equal(chipRight.correct, true);
	assert.equal(dockRight.correct, true);
	assert.equal(chipRight.explanation, "Mercury is the smallest planet.");
});

test("a nonempty wrong selection grades false — never silently correct", () => {
	const qd = questionDataFor("call-2", "quiz", quizInput());
	const wrong = buildAnswer(qd, { values: ["venus"] });
	assert.equal(wrong.answers.length, 1, "the pick is recorded, not dropped");
	assert.equal(wrong.correct, false);

	const shifted = buildAnswer(qd, { values: ["mercury", "venus"] });
	assert.equal(shifted.correct, false, "an extra selection breaks the exact set");
});

test("labels, values, and 1-based display numbers all resolve exactly", () => {
	const qd = questionDataFor("call-3", "quiz", quizInput());
	assert.deepEqual(answerRequestForText(qd, "  MERCURY "), { values: ["mercury"], thinking: "MERCURY" });
	assert.deepEqual(answerRequestForText(qd, "mars"), { values: ["mars"], thinking: "mars" });
	const third = qd.options[2]!;
	assert.deepEqual(answerRequestForText(qd, "3"), { values: [third.value], thinking: "3" });
	// A partial word is not an option.
	assert.throws(() => answerRequestForText(qd, "merc"), /not one of this question's options/);
	// No confidence is invented by the chip lane.
	assert.equal("confidence" in answerRequestForText(qd, "mars"), false);
});

test("multi-select takes comma- and newline-separated entries, whole literal first", () => {
	const qd = questionDataFor(
		"call-4",
		"quiz",
		quizInput({
			multiSelect: true,
			options: [
				{ label: "Belize, Honduras", value: "central" },
				{ label: "Niue", value: "niue" },
				{ label: "Tuvalu", value: "tuvalu" },
			],
			correctAnswer: ["central", "niue"],
		}),
	);
	// The quiz builder shuffles display order; these assertions hold at any order.
	const central = qd.options.findIndex((option) => option.value === "central") + 1;
	const niue = qd.options.findIndex((option) => option.value === "niue") + 1;

	// The whole string wins before any comma splitting.
	assert.deepEqual(answerRequestForText(qd, "Belize, Honduras"), {
		values: ["central"],
		thinking: "Belize, Honduras",
	});
	assert.deepEqual([...(answerRequestForText(qd, "niue, tuvalu").values ?? [])].sort(), ["niue", "tuvalu"]);
	assert.deepEqual([...(answerRequestForText(qd, `${central}\n${niue}`).values ?? [])].sort(), ["central", "niue"]);
	assert.equal(buildAnswer(qd, answerRequestForText(qd, "central, niue")).correct, true, "the authored pair");
	assert.equal(buildAnswer(qd, answerRequestForText(qd, "Niue, tuvalu")).correct, false, "a real wrong answer stays wrong");

	// One unknown token spoils the batch rather than guessing a nearest match.
	const before = "niue, what";
	assert.throws(
		() => answerRequestForText(qd, before),
		/not one of this question's options[\s\S]*Belize, Honduras/,
	);
	assert.equal(before, "niue, what", "the draft string is untouched");
});

test("single-select rejects multiple entries and unknown words without producing an answer", () => {
	const qd = questionDataFor("call-5", "quiz", quizInput());
	assert.throws(() => answerRequestForText(qd, "mercury, mars"), /takes exactly one answer/);
	assert.throws(() => answerRequestForText(qd, "pluto"), /not one of this question's options/);
	assert.throws(() => answerRequestForText(qd, "   "), /Type an answer first/);
	// Nothing is fabricated into a request for the unknown case.
	assert.throws(() => answerRequestForText(qd, "pluto"), (error: Error) => {
		assert.match(error.message, /Mercury/);
		return true;
	});
});

test("the explain commitment survives the canonical build and the answer record", () => {
	const input = {
		type: "predict",
		nodeId: "node-2",
		question: "Why does ice float?",
		correctAnswer: "Ice is less dense than liquid water: the hydrogen bonds freeze into an open lattice.",
	} as ExplainToolInput;
	const qd = questionDataFor("call-6", "explain", input);
	assert.equal(qd.kind, "explain");
	assert.equal(qd.mode, "text");
	assert.equal(qd.committedAnswer, input.correctAnswer);
	assert.equal(qd.questionType, "predict");

	const request = answerRequestForText(qd, "  Because it is less dense.  ");
	assert.deepEqual(request, { text: "Because it is less dense." });
	const answer = buildAnswer(qd, request, "explain");
	assert.equal(answer.committed, input.correctAnswer);
	assert.equal(answer.correct, undefined, "free recall is graded by the model, never the client");
});

test("ask keeps free-form prose in Other, and listed options stay selections", () => {
	const ask = {
		question: "Which pace suits you?",
		options: [
			{ label: "Slow", value: "slow" },
			{ label: "Fast", value: "fast" },
		],
	} as AskToolInput;
	const qd = questionDataFor("call-7", "ask_user_question", ask);
	assert.equal(qd.mode, "single-select");
	assert.deepEqual(answerRequestForText(qd, "Fast"), { values: ["fast"], thinking: "Fast" });
	assert.deepEqual(answerRequestForText(qd, "a bit of both, honestly"), { other: "a bit of both, honestly" });

	const textQd = questionDataFor("call-8", "ask_user_question", { question: "Anything else?" } as AskToolInput);
	assert.equal(textQd.mode, "text");
	assert.deepEqual(answerRequestForText(textQd, "  notes  "), { text: "notes" });
});

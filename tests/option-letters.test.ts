import assert from "node:assert/strict";
import { test } from "node:test";
import { newAnswerResult } from "../src/core/native-messages.ts";
import {
	buildAnswer, compactAnswerForModel, dismissedAnswer, displayedOptionLetter, normalizeOptions,
	questionDisplayOptions, resolveCorrect, seededRandom, shuffleOptions, type QuestionData,
} from "../src/core/question-core.ts";

const authored = [
	{ label: "Mercury", value: "m" }, { label: "Venus", value: "v" }, { label: "Earth", value: "e" },
];

function question(kind: "quiz" | "ask", id: string): QuestionData {
	const displayed = questionDisplayOptions(authored, kind, false, id);
	return {
		id, kind, question: "Which planet?", mode: "single-select", ...displayed,
		correctIndices: kind === "quiz" ? resolveCorrect("v", displayed.options).indices : undefined,
		createdAt: "2026-01-01",
	};
}

test("letters map back to authored positions without changing the seeded permutation or grading", () => {
	const q = question("quiz", "q2");
	assert.deepEqual(q.options, shuffleOptions(normalizeOptions(authored), seededRandom(q.id)));
	assert.notDeepEqual(q.options, normalizeOptions(authored), "exercise a nonidentity shuffle");
	for (const [i, option] of q.options.entries()) {
		const letter = String.fromCharCode(65 + i);
		assert.equal(authored[q.optionOrder![letter]! - 1]!.value, option.value);
	}
	const answer = buildAnswer(q, { values: ["v"], thinking: "I ruled out A." }, "quiz");
	const result = newAnswerResult(q.id, "quiz", answer);
	assert.deepEqual(result.details, answer);
	const json = JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "");
	assert.deepEqual(json, {
		kind: "quiz", optionOrder: q.optionOrder, correct: true, thinking: "I ruled out A.",
		answers: [{ index: q.correctIndices![0], label: "Venus", letter: String.fromCharCode(64 + q.correctIndices![0]!) }],
	});
	assert.deepEqual(compactAnswerForModel(buildAnswer(q, { dontKnow: true })), { kind: "quiz", dontKnow: true, optionOrder: q.optionOrder });
});

test("ask preserves author order and Other still supplies the map without a selected letter", () => {
	const q = question("ask", "ask1");
	assert.deepEqual(q.options, normalizeOptions(authored));
	assert.deepEqual(q.optionOrder, { A: 1, B: 2, C: 3 });
	assert.deepEqual(compactAnswerForModel(buildAnswer(q, { other: "Mars", thinking: "Not B" })), {
		kind: "ask", optionOrder: { A: 1, B: 2, C: 3 }, other: "Mars", thinking: "Not B",
	});
});

test("A–Z only; legacy empty rows don't shift the original index; legacy answers stay unlettered", () => {
	const many = Array.from({ length: 27 }, (_, i) => ({ label: String(i) }));
	assert.equal(questionDisplayOptions(many, "ask", false, "q").optionOrder, undefined);
	const max = questionDisplayOptions(many.slice(0, 26), "ask", false, "q").optionOrder;
	assert.equal(displayedOptionLetter(max, 26), "Z");
	assert.equal(displayedOptionLetter(max, 27), undefined);
	assert.equal(questionDisplayOptions(authored, "quiz", true, "q").optionOrder, undefined);
	assert.equal(questionDisplayOptions(authored, "ask", true, "q").optionOrder, undefined);
	assert.equal(questionDisplayOptions(undefined, "ask", false, "q").optionOrder, undefined);
	assert.deepEqual(questionDisplayOptions([{ label: " " }, ...authored], "ask", false, "q").optionOrder, { A: 2, B: 3, C: 4 });
	const q = question("ask", "legacy");
	const legacy = buildAnswer({ ...q, optionOrder: undefined }, { values: ["m"] });
	assert.deepEqual(compactAnswerForModel(legacy), { kind: "ask", answers: [{ index: 1, label: "Mercury" }] });
	assert.deepEqual(compactAnswerForModel(dismissedAnswer("ask", "Which planet?")), { kind: "ask", dismissed: true });
});

/**
 * Probe calibration summary (issue #390) — the deterministic fold of the
 * probe's quiz answers, attached to the probe→plan handoff.
 *
 * These tests pin the rules that keep the block honest: dismissed answers
 * are excluded, "don't know" is its own count, an untouched 50 is never a
 * coin flip, a legacy 50 is never retroactively classified, free recall
 * reports "unavailable" instead of inferring, and at/below chance uses the
 * question's own option count.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeCalibrationText } from "../src/core/calibration.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

let callSeq = 0;

/** One persisted answer tool result, through the production helper so the
 *  scan sees exactly the shape the record carries (`details` = the full
 *  graded QuestionAnswerData). */
function answer(overrides: Partial<QuestionAnswerData>): LhMessage {
	callSeq++;
	return newAnswerResult(`call_${callSeq}`, "probe", {
		kind: "quiz",
		questionText: "Which one?",
		options: [
			{ index: 1, label: "a" },
			{ index: 2, label: "b" },
			{ index: 3, label: "c" },
			{ index: 4, label: "d" },
		],
		dontKnow: false,
		answers: [{ label: "a", value: "a", index: 1 }],
		correct: true,
		correctIndices: [1],
		answeredAt: "2026-11-01T00:00:00.000Z",
		...overrides,
	} as QuestionAnswerData) as LhMessage;
}

describe("probe calibration: explicit vs default vs legacy 50", () => {
	const text = probeCalibrationText([
		answer({ confidence: 90, confidenceTouched: true, correct: true }),
		answer({ confidence: 50, confidenceTouched: true, correct: false }),
		answer({ confidence: 50, confidenceTouched: false, correct: true }),
		answer({ confidence: 50, confidenceTouched: undefined, correct: false }),
		answer({ confidence: undefined, dontKnow: true, correct: false }),
		answer({ dismissed: true, confidence: undefined }),
	]);

	it("counts every non-dismissed quiz answer, with don't-know separate", () => {
		assert.match(text, /^CALIBRATION — probe phase$/m);
		assert.match(text, /^Quiz answers: 5$/m);
		assert.match(text, /^ {2}explicit confidence: 2$/m);
		assert.match(text, /^ {2}default-50 \(untouched\): 1$/m);
		assert.match(text, /^ {2}legacy 50 \(unclassified\): 1$/m);
		assert.match(text, /^ {2}"don't know": 1$/m);
	});

	it("splits the 50 band and never promotes default or legacy 50s to coin flips", () => {
		assert.match(text, /^50 explicit +0 +1$/m);
		assert.match(text, /^50 default +1 +0$/m);
		assert.match(text, /^50 legacy +0 +1$/m);
		assert.match(text, /^ {2}explicit coin flips: 1$/m);
		assert.match(text, /^ {2}default-50 answers: 1$/m);
	});

	it("only meaningful answers feed the confidence signals", () => {
		// the default-50 correct answer is ambiguous, not "fragile";
		// the legacy-50 wrong answer is ambiguous too.
		assert.match(text, /^ {2}fragile correct answers: 0$/m);
		assert.match(text, /^ {2}high-confidence misses: 0$/m);
	});

	it("states the denominator instead of presenting rates", () => {
		assert.match(text, /Bands cover 4 graded answers; "don't know" is reported above\./);
		assert.match(text, /Evidence, not a verdict/);
	});
});

describe("probe calibration: signals", () => {
	it("counts high-confidence misses and fragile correct answers", () => {
		const text = probeCalibrationText([
			answer({ confidence: 100, confidenceTouched: true, correct: false }),
			answer({ confidence: 90, confidenceTouched: true, correct: false }),
			answer({ confidence: 30, confidenceTouched: true, correct: true }),
		]);
		assert.match(text, /^90–100 +0 +2$/m);
		assert.match(text, /^30 +1 +0$/m);
		assert.match(text, /high-confidence misses: 2/);
		assert.match(text, /fragile correct answers: 1/);
	});

	it("at/below chance reads the question's option count", () => {
		const four = probeCalibrationText([answer({ confidence: 0, confidenceTouched: true, correct: false })]);
		assert.match(four, /at\/below chance: 1/);

		// 30% is below chance on 2 options (50) but above chance on 4 (25):
		const two = probeCalibrationText([
			answer({
				confidence: 30,
				confidenceTouched: true,
				correct: false,
				options: [
					{ index: 1, label: "a" },
					{ index: 2, label: "b" },
				],
			}),
		]);
		assert.match(two, /at\/below chance: 1/);

		const fourHigh = probeCalibrationText([answer({ confidence: 30, confidenceTouched: true, correct: false })]);
		assert.match(fourHigh, /at\/below chance: 0/);
	});

	it("an all-\"don't know\" probe reports no graded answers", () => {
		const text = probeCalibrationText([answer({ dontKnow: true, correct: false, confidence: undefined })]);
		assert.match(text, /Quiz answers: 1/);
		assert.match(text, /\(no graded answers\)/);
		assert.match(text, /\n {2}high-confidence misses: 0$/m);
	});
});

describe("probe calibration: honest unavailability", () => {
	it("free recall states that calibration is unavailable rather than inferring", () => {
		callSeq++;
		const recall = newAnswerResult(`call_${callSeq}`, "recall", {
			kind: "explain",
			questionText: "Explain it.",
			dontKnow: false,
			answers: [],
			answeredAt: "2026-11-01T00:00:00.000Z",
		} as QuestionAnswerData) as LhMessage;
		const text = probeCalibrationText([recall]);
		assert.match(text, /^CALIBRATION — probe phase$/m);
		assert.match(text, /Calibration unavailable — the probe used free recall/);
		assert.match(text, /Do not infer calibration/);
	});

	it("an empty probe says so plainly", () => {
		const text = probeCalibrationText([]);
		assert.match(text, /Calibration unavailable — the probe recorded no quiz answers/);
	});
});

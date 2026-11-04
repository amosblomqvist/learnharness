/**
 * Probe-phase calibration summary (issue #390).
 *
 * A DETERMINISTIC fold of the probe's quiz answers, computed at the
 * probe→plan handoff and attached to the handoff steer so the planning
 * agent receives the confidence-vs-correctness signal as counts, never as
 * a model-authored estimate. Code produces this; the model only reads it.
 *
 * It is evidence, not a verdict: no thresholds, no rules, no learner score.
 * The raw records stay authoritative — this is one compact projection of
 * them, and the plan agent decides what it means.
 *
 * The confidence slider resting default is 50, so a 50 is only a committed
 * coin flip when the learner actually moved the slider (`confidenceTouched`).
 * Untouched 50s and legacy records (pre-flag) are reported separately and
 * never counted as coin flips.
 */

import type { LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";

/** One graded quiz answer, reduced to what calibration reads. */
interface GradedAnswer {
	confidence: number;
	/** true = the learner moved the slider; false = the untouched 50
	 *  default; undefined = a legacy record written before the flag. */
	touched: boolean | undefined;
	correct: boolean;
	/** Number of options the question displayed (chance = 1/options). */
	optionCount: number;
}

interface FoldedAnswers {
	graded: GradedAnswer[];
	dontKnow: number;
	/** Probe-phase free-recall answers (no confidence by construction). */
	freeRecall: number;
}

/** Scan a native record for answered questions. At the handoff the
 *  transcript is entirely probe-phase, so every quiz answer belongs to
 *  the probe — no tool-name gate is needed (and legacy pre-rename records
 *  have no probe/quiz distinction to gate on anyway). */
function foldAnswers(messages: readonly LhMessage[]): FoldedAnswers {
	const folded: FoldedAnswers = { graded: [], dontKnow: 0, freeRecall: 0 };
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const details = message.details as Partial<QuestionAnswerData> | undefined;
		if (!details || typeof details !== "object") continue;
		if (details.dismissed === true) continue; // skips carry no calibration evidence
		if (details.kind === "explain") {
			folded.freeRecall++;
			continue;
		}
		if (details.kind !== "quiz") continue;
		if (details.dontKnow === true) {
			folded.dontKnow++;
			continue;
		}
		if (typeof details.confidence !== "number") continue; // no stated confidence
		folded.graded.push({
			confidence: details.confidence,
			touched: details.confidenceTouched,
			correct: details.correct === true,
			optionCount: Array.isArray(details.options) ? details.options.length : 0,
		});
	}
	return folded;
}

/** A confidence is meaningful evidence unless it is an ambiguous 50: the
 *  untouched default and a legacy record's unclassified 50 say nothing
 *  about what the learner believed. A deliberate 50 does. */
function isMeaningful(answer: GradedAnswer): boolean {
	return answer.confidence !== 50 || answer.touched === true;
}

type Band =
	| "90–100"
	| "70"
	| "50–69"
	| "50 explicit"
	| "50 default"
	| "50 legacy"
	| "30"
	| "30–49"
	| "0"
	| "0–29";

const BAND_ORDER: readonly Band[] = [
	"90–100",
	"70",
	"50–69",
	"50 explicit",
	"50 default",
	"50 legacy",
	"30",
	"30–49",
	"0",
	"0–29",
];

function bandOf(answer: GradedAnswer): Band {
	const c = answer.confidence;
	if (c >= 90) return "90–100";
	if (c >= 70) return "70";
	if (c > 50) return "50–69";
	if (c === 50) {
		if (answer.touched === true) return "50 explicit";
		if (answer.touched === false) return "50 default";
		return "50 legacy";
	}
	if (c >= 30) return c === 30 ? "30" : "30–49";
	return c === 0 ? "0" : "0–29";
}

/** Fixed-column row: the block is read as text by the model. */
function row(label: string, correct: number | string, wrong: number | string = ""): string {
	return `${label.padEnd(17)}${String(correct).padStart(7)}${String(wrong).padStart(8)}`;
}

/**
 * Render the calibration block for one probe transcript. Always returns a
 * block: when the probe carries no usable confidence evidence, it says so
 * plainly rather than guessing (free recall has no confidence; legacy and
 * untouched 50s are ambiguous).
 */
export function probeCalibrationText(messages: readonly LhMessage[]): string {
	const { graded, dontKnow, freeRecall } = foldAnswers(messages);
	const lines: string[] = ["CALIBRATION — probe phase"];

	if (graded.length === 0 && dontKnow === 0) {
		lines.push(
			freeRecall > 0
				? "Calibration unavailable — the probe used free recall, which carries no stated confidence. Do not infer calibration from it."
				: "Calibration unavailable — the probe recorded no quiz answers.",
		);
		return lines.join("\n");
	}

	const explicit = graded.filter(isMeaningful).length;
	const default50 = graded.filter((a) => a.confidence === 50 && a.touched === false).length;
	const legacy50 = graded.filter((a) => a.confidence === 50 && a.touched === undefined).length;

	lines.push(`Quiz answers: ${graded.length + dontKnow}`);
	lines.push(`  explicit confidence: ${explicit}`);
	lines.push(`  default-50 (untouched): ${default50}`);
	lines.push(`  "don't know": ${dontKnow}`);
	if (legacy50 > 0) lines.push(`  legacy 50 (unclassified): ${legacy50}`);
	lines.push("");

	lines.push(row("Confidence band", "Correct", "Wrong"));
	const byBand = new Map<Band, { correct: number; wrong: number }>();
	for (const answer of graded) {
		const band = bandOf(answer);
		const counts = byBand.get(band) ?? { correct: 0, wrong: 0 };
		if (answer.correct) counts.correct++;
		else counts.wrong++;
		byBand.set(band, counts);
	}
	let rows = 0;
	for (const band of BAND_ORDER) {
		const counts = byBand.get(band);
		if (!counts) continue;
		lines.push(row(band, counts.correct, counts.wrong));
		rows++;
	}
	if (rows === 0) lines.push(row("(no graded answers)", "", ""));
	else lines.push(`Bands cover ${graded.length} graded answer${graded.length === 1 ? "" : "s"}; "don't know" is reported above.`);
	lines.push("");

	const highConfidenceMisses = graded.filter((a) => a.confidence >= 90 && !a.correct).length;
	const fragileCorrect = graded.filter((a) => a.correct && a.confidence <= 50 && isMeaningful(a)).length;
	const explicitCoinFlips = graded.filter((a) => a.confidence === 50 && a.touched === true).length;
	const atOrBelowChance = graded.filter((a) => {
		if (!isMeaningful(a) || a.optionCount <= 0) return false;
		return a.confidence <= 100 / a.optionCount;
	}).length;
	const default50Answers = graded.filter((a) => a.confidence === 50 && a.touched === false).length;

	lines.push("Signals:");
	lines.push(`  high-confidence misses: ${highConfidenceMisses}`);
	lines.push(`  fragile correct answers: ${fragileCorrect}`);
	lines.push(`  explicit coin flips: ${explicitCoinFlips}`);
	lines.push(`  at/below chance: ${atOrBelowChance}`);
	lines.push(`  default-50 answers: ${default50Answers}`);
	lines.push("");
	lines.push(
		"Evidence, not a verdict: high-confidence misses suggest committed misconceptions to repair before building on them; " +
			"fragile correct answers suggest reinforcing or testing transfer; explicit coin flips mean insufficient evidence — " +
			"probe more or avoid strong assumptions; at/below chance suggests distrust or trap suspicion, not ordinary low confidence.",
	);
	return lines.join("\n");
}

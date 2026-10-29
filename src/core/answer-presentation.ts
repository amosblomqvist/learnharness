/** Read-only provenance for historical question cards. Never persist this
 * projection: answer identities, ordering, grading, and learner text remain
 * the recorded facts; only model-authored display text comes from the call. */
import { normalizeOptions, type QuestionAnswerData } from "./question-core.ts";
import { parseAskInput, parseExplainInput, parseQuizInput } from "./tool-parts.ts";
import { repairMathForDisplay } from "./math-delims.ts";

export function answerForPresentation(answer: QuestionAnswerData, input: unknown): QuestionAnswerData {
	if (answer.dismissed) return answer;
	const quiz = answer.kind === "quiz" ? parseQuizInput(input) : undefined;
	const explain = answer.kind === "explain" ? parseExplainInput(input) : undefined;
	const source = quiz ?? explain ?? (answer.kind === "ask" ? parseAskInput(input) : undefined);
	if (!source) return answer;
	const projected = { ...answer, questionText: source.question };
	if (quiz) projected.explanation = quiz.explanation;
	if (explain) projected.committed = explain.correctAnswer;
	if (!answer.options?.length || !("options" in source) || !source.options?.length) return projected;

	const original = normalizeOptions(source.options);
	const saved = answer.options;
	const bindings = new Map<number, number>(); // saved position -> original position
	const used = new Set<number>();
	const bindUnique = (candidates: number[][]) => {
		for (let si = 0; si < saved.length; si++) {
			if (bindings.has(si)) continue;
			const possible = candidates[si]!.filter((oi) => !used.has(oi));
			if (possible.length !== 1) continue;
			const oi = possible[0]!;
			// Two saved rows claiming the same source are ambiguous, even if
			// each row independently has just one candidate.
			if (candidates.some((other, sj) => sj !== si && !bindings.has(sj) && other.includes(oi))) continue;
			bindings.set(si, oi);
			used.add(oi);
		}
	};
	// Selected-answer values are stable identities when the record retained
	// them. Do not normalize those values, recompute a shuffle, or regrade.
	bindUnique(saved.map((option) => {
		const values = answer.answers.filter((a) => a.index === option.index).map((a) => a.value);
		return original.flatMap((o, oi) => values.includes(o.value) ? [oi] : []);
	}));
	const recoveredLabels = original.map((o) => repairMathForDisplay(o.label));
	bindUnique(saved.map((option) => original.flatMap((o, oi) =>
		o.label === option.label || recoveredLabels[oi] === option.label ? [oi] : [])));
	// A bijection with one remaining pair has no ordering ambiguity. With
	// multiple unmatched rows, keep their snapshots rather than guess.
	if (saved.length === original.length && bindings.size === saved.length - 1) {
		const si = saved.findIndex((_, i) => !bindings.has(i));
		const oi = original.findIndex((_, i) => !used.has(i));
		bindings.set(si, oi);
	}
	projected.options = saved.map((option, si) => {
		const oi = bindings.get(si);
		return oi === undefined ? option : { ...option, label: original[oi]!.label };
	});
	return projected;
}

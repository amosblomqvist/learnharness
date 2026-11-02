import { normalizeOptions, seededRandom, shuffleOptions, type QuestionData } from "./question-core.ts";
import { markdownNarration } from "./narration.ts";

/** One display-order transformation for both the dock and narration. */
export function visibleQuestionOptions(kind: QuestionData["kind"], toolCallId: string, options: Parameters<typeof normalizeOptions>[0]) {
	const normalized = normalizeOptions(options);
	return kind === "quiz" ? shuffleOptions(normalized, seededRandom(toolCallId)) : normalized;
}

/** Explicit learner-visible allowlist: answer keys and hidden feedback never enter speech. */
export function questionNarration(question: Pick<QuestionData, "question" | "context" | "mode" | "options" | "kind">): string {
	// Every learner-visible string goes through the same Markdown projection as teacher prose, so code, emphasis and math read the same way.
	const prose = (text: string | undefined) => (text ? markdownNarration(text, true) : "");
	return [prose(question.question), prose(question.context), question.mode === "multi-select" ? "Select all that apply." : "",
		...question.options.map((option, index) => `Choice ${index + 1}. ${prose(option.label)}${option.description ? ` ${prose(option.description)}` : ""}`),
		question.kind === "quiz" ? "I don't know." : question.kind === "ask" && question.options.length ? "Other." : "",
	].filter(Boolean).join("\n\n");
}

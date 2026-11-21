import type { LhMessage } from "./native-messages.ts";

const graded = new Set(["quiz", "probe", "explain", "recall"]);
export interface AnswerReview { answerId: string; questionCallId: string; sourceMessageId: string }

/** A completed tutor reaction after a real graded answer. Asking preferences,
 * dismissals, failures and unfinished parallel-question batches are not reviews. */
export function answerReviewOf(messages: readonly LhMessage[]): AnswerReview | undefined {
	let reacted = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "user") return;
		if (message.role === "assistant") {
			if (!["error", "aborted", "pending", "length"].includes(message.stopReason)) reacted = true;
			continue;
		}
		if (message.role !== "toolResult" || !graded.has(message.toolName)) continue;
		if (!reacted || message.isError || !message.details || typeof message.details !== "object" || Array.isArray(message.details)) return;
		if ((message.details as { dismissed?: boolean }).dismissed) return;
		if (!["quiz", "explain"].includes((message.details as { kind?: string }).kind ?? "")) return;
		for (let j = i - 1; j >= 0; j--) {
			const source = messages[j]!;
			if (source.role !== "assistant") continue;
			if (source.content.some(block => block.type === "toolCall" && block.id === message.toolCallId && block.name === message.toolName))
				return { answerId: message.id, questionCallId: message.toolCallId, sourceMessageId: source.id };
		}
		return;
	}
}

export type LearningMode = "clarify" | "feynman";
export const FEYNMAN_TAG = "[Feynman practice]";
export const CLARIFY_TAG = "[Direct clarification]";
export function learningRequest(text: string, mode?: LearningMode): string {
	if (text.startsWith(`${FEYNMAN_TAG}\n`) || text.startsWith(`${CLARIFY_TAG}\n`)) return text;
	return mode ? `${mode === "feynman" ? FEYNMAN_TAG : CLARIFY_TAG}\n${text}` : text;
}
export function learningModeOf(messages: readonly { role: string; text: string }[]): LearningMode | undefined {
	for (const message of [...messages].reverse()) {
		if (message.role !== "user") continue;
		if (message.text.startsWith(`${FEYNMAN_TAG}\n`)) return "feynman";
		if (message.text.startsWith(`${CLARIFY_TAG}\n`)) return "clarify";
	}
}

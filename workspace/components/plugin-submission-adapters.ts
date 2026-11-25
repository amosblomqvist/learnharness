import type { AnswerRequest, ChatInput, PluginSubmission, PluginSubmissionImages, QuestionData } from "../src/core/index.ts";
export interface BuiltinSubmissionCapture {
	question: QuestionData;
	capture(): AnswerRequest;
	isCurrent(): boolean;
}
export type PrepareBuiltinSubmission = (capture: BuiltinSubmissionCapture) => void;
export type PrepareThinkingSubmission = (capture: () => string, onAccepted: (captured: string) => void) => void;
export type PreparePluginProblemSubmission = (capture: () => Extract<ChatInput, { type: "plugin-problem-submission" }>, isCurrent: () => boolean, onAccepted: () => void) => Promise<boolean>;
export type PreparePluginQuestionSubmission = (capture: () => Extract<ChatInput, { type: "plugin-question-answer" }>, isCurrent: () => boolean) => Promise<boolean>;
export function submissionImages(input: Extract<PluginSubmission, { type: "answer" | "plugin-question-answer" }>, channels: readonly string[]): PluginSubmissionImages | undefined {
	const answer = input.type === "answer" ? input.answer.images : input.answerImages;
	const images = { ...(answer.length ? { answer } : {}), ...(channels.includes("thinking") && input.thinking.images.length ? { thinking: input.thinking.images } : {}), ...(channels.includes("readingThinking") && input.readingThinking.images.length ? { readingThinking: input.readingThinking.images } : {}) };
	return Object.keys(images).length ? images : undefined;
}

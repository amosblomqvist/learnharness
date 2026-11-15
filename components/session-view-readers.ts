/** Private read-only bridges to the actual mounted input owners; never a second state model. */
import { useState } from "react";
import type { QuestionData, PluginSubmissionTarget, PluginNativeQuestionViewDraft, PluginSessionViewInput } from "@/src/core";
export interface ViewReaderRef<T> { current: (() => T) | null; changed?(): void }
/** A view reader that can carry `changed`. Not useRef: React's development
 *  server renderer seals useRef objects, so adding `changed` threw during SSR. */
export function useViewReaderRef<T>(): ViewReaderRef<T> {
  return useState<ViewReaderRef<T>>(() => ({ current: null }))[0];
}
export interface NativeQuestionViewState {
  question: QuestionData;
  draft: Omit<PluginNativeQuestionViewDraft, "readingThinking">;
}
export type SessionInputViewReader = ViewReaderRef<PluginSessionViewInput>;
export interface SessionViewTargets {
  text: Extract<PluginSubmissionTarget, { type: "text" }>;
  answer(question: QuestionData): Extract<PluginSubmissionTarget, { type: "answer" }> | undefined;
  thinking?: Extract<PluginSubmissionTarget, { type: "thinking" }>;
  pluginQuestion?: Extract<PluginSubmissionTarget, { type: "plugin-question-answer" }>;
  pluginProblem?: Extract<PluginSubmissionTarget, { type: "plugin-problem-submission" }>;
}

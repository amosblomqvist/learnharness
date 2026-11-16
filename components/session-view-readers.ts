/** Private read-only bridges to the actual mounted input owners; never a second state model. */
import type { QuestionData, PluginSubmissionTarget, PluginNativeQuestionViewDraft, PluginSessionViewInput } from "@/src/core";
export interface ViewReaderRef<T> { current: (() => T) | null; changed?(): void }
export interface NativeQuestionViewState {
  question: QuestionData;
  draft: Omit<PluginNativeQuestionViewDraft, "readingThinking">;
}
export type SessionInputViewReader = ViewReaderRef<PluginSessionViewInput>;

/** A reader object for a mounted dock to read a session's input from.
 *
 * Hold it with `useState(() => createViewReader())`, NOT `useRef`: React's
 * DEVELOPMENT server renderer seals the object `useRef` returns
 * (`react-dom-server.node.development.js`, server `useRef`: `Object.seal` on
 * `{ current }`), so installing the `changed` notifier afterwards throws during
 * SSR with "Cannot add property changed, object is not extensible" — and takes
 * every session page down with a 500. A state-held plain object is stable across
 * renders and stays extensible, so both `current` and `changed` can be set. */
export function createViewReader<T>(): ViewReaderRef<T> {
	return { current: null, changed: undefined };
}
export interface SessionViewTargets {
  text: Extract<PluginSubmissionTarget, { type: "text" }>;
  answer(question: QuestionData): Extract<PluginSubmissionTarget, { type: "answer" }> | undefined;
  thinking?: Extract<PluginSubmissionTarget, { type: "thinking" }>;
  pluginQuestion?: Extract<PluginSubmissionTarget, { type: "plugin-question-answer" }>;
  pluginProblem?: Extract<PluginSubmissionTarget, { type: "plugin-problem-submission" }>;
}

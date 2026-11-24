import { pendingPluginQuestionOf, pluginQuestionCallsOf, samePluginQuestionOccurrence, type PluginQuestionOccurrence, type LhMessage } from "@/src/core";

/** Private confirmation identity, captured when the existing dialog opens. */
export interface PluginQuestionDismissalTarget {
	readonly occurrence: PluginQuestionOccurrence;
	readonly questionId?: string;
}
export function capturePluginQuestionDismissal(messages: readonly LhMessage[]): PluginQuestionDismissalTarget | null {
	const pending = pendingPluginQuestionOf(messages);
	const unreadable = pending ? undefined : pluginQuestionCallsOf(messages).find(call => call.status === "unreadable");
	const occurrence = pending?.occurrence ?? unreadable?.occurrence;
	if (!occurrence) return null;
	const annotation = unreadable?.annotation;
	const questionId = pending?.questionId ?? (annotation?.status === "unreadable" ? annotation.binding?.questionId ?? annotation.identity?.questionId : undefined);
	return Object.freeze({ occurrence: Object.freeze({ ...occurrence }), ...(questionId === undefined ? {} : { questionId }) });
}

/** Same canonical question only. Detach the old local submission before the
 * silent route parks+stops its server owner; its late refusal must not repaint
 * an error. No new abort request, answer, draft mutation or teacher wake. */
export function confirmPluginQuestionDismissal(target: PluginQuestionDismissalTarget, current: {
	canonicalMessages: readonly LhMessage[];
	reconciliation: "ready" | "syncing" | "failed";
	stop(): void;
	dismissPluginQuestion(occurrence: PluginQuestionOccurrence, questionId?: string): Promise<void>;
}): void {
	if (current.reconciliation !== "ready") return;
	const pending = capturePluginQuestionDismissal(current.canonicalMessages);
	if (!pending || pending.questionId !== target.questionId || !samePluginQuestionOccurrence(pending.occurrence, target.occurrence)) return;
	current.stop();
	void current.dismissPluginQuestion(target.occurrence, target.questionId);
}

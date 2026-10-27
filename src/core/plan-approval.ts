import { planReviewResults, successfulToolResultIds, type LhMessage } from "./native-messages.ts";

/** New presentations require an explicit learner decision. Old records without
 * this protocol keep their established behavior until a diagnostic reopens.
 * A review authorizes only the presentation that preceded its question. */
export function planApprovalPending(messages: readonly LhMessage[]): boolean {
	const plans = successfulToolResultIds(messages, "plan_init");
	const resumed = successfulToolResultIds(messages, "resume_probe");
	const decisions = planReviewResults(messages);
	const reviews = new Map<string, string | null>();
	let plan: string | null = null;
	let pending = false;
	for (const message of messages) {
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "ask_user_question") reviews.set(block.id, plan);
			}
		}
		if (plans.has(message.id)) {
			plan = message.id;
			if (message.role === "toolResult" && (message.details as { approvalRequired?: boolean })?.approvalRequired) pending = true;
		}
		if (message.role === "toolResult" && plan !== null && reviews.get(message.toolCallId) === plan) {
			const decision = decisions.get(message.id);
			if (decision === "accept") pending = false;
			if (decision === "revise") pending = true;
		}
		if (resumed.has(message.id) || decisions.get(message.id) === "probe") {
			pending = true;
			plan = null;
		}
	}
	return pending;
}

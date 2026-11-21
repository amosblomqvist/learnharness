import type { LhViewMessage } from "@/src/core";

export function isSubagentSteer(message: LhViewMessage): boolean {
	return (message.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

/** Keep the latest learner turn and any live tail fully laid out. Background
 * deliveries and aborts carry teacher-facing text, not a new learner turn. */
export function newestLearnerTurnFrom(messages: readonly LhViewMessage[]): number {
	return messages.findLastIndex((message) => message.role === "user" && !isSubagentSteer(message)
		&& message.parts.some((part) => part.type === "text" || part.type === "image"));
}

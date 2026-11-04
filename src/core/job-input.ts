import type { JobRecord } from "./contracts/jobs.ts";
import type { LhMessage } from "./native-messages.ts";

/** Saved dispatch arguments take precedence over legacy transcript input. */
export function resolveJobInput(job: JobRecord, messages: readonly LhMessage[]): unknown {
	if (job.input !== undefined) return job.input;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.id === job.toolCallId && block.name === job.kind) {
				return block.arguments;
			}
		}
	}
	return undefined;
}

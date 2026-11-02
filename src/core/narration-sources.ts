import { failedOutputCallIds, sendToUserText, type LhMessage } from "./native-messages.ts";
import type { NarrationSource } from "./narration-controller.ts";

export interface TeacherNarrationSource extends NarrationSource { viewPartId: string }
/** Select only learner-facing native content blocks, retaining their actual block index. */
export function teacherNarrationSources(messages: readonly LhMessage[], running: boolean, failed = false): TeacherNarrationSource[] {
	const failedCalls = failedOutputCallIds(messages);
	const sources: TeacherNarrationSource[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "custom" && message.customType === "subagent-steer" && message.details && typeof message.details === "object") {
			const artifact = message.details as { kind?: unknown; result?: { title?: unknown; html?: unknown } };
			if (artifact.kind === "demo" && typeof artifact.result?.title === "string" && typeof artifact.result.html === "string" && artifact.result.html.length) {
				sources.push({ id: `${message.id}:artifact-title`, viewPartId: `sa_${message.id}`, markdown: artifact.result.title.replace(/[\\`*_{}[\]()#+.!<>$|~]/g, "\\$&"), complete: true });
			}
		}
		if (message.role !== "assistant") continue;
		let textIndex = 0;
		for (const [blockIndex, block] of message.content.entries()) {
			let text: string | undefined;
			if (block.type === "text") text = block.text;
			else if (block.type === "toolCall" && !failedCalls.has(block.id)) text = sendToUserText(block);
			if (text === undefined) continue;
			sources.push({ id: `${message.id}:${blockIndex}`, viewPartId: `${message.id}-t${textIndex++}`, markdown: text,
				complete: !running || messageIndex < messages.length - 1,
				failed: message.stopReason === "error" || message.stopReason === "aborted" || (failed && messageIndex === messages.length - 1) });
		}
	}
	return sources;
}

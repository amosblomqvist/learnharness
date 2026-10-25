import { createHash } from "node:crypto";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";

type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function acpHistory(messages: readonly Message[]) {
	return messages.filter((message) => message.role !== "system").map((message) => {
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const details = message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {};
		return { role: message.role, ...details, content: content.filter((part) => part.type !== "thinking") };
	});
}

/** Compare model-facing content, ignoring app IDs, timestamps, and accounting.
 * Object key order can change during persistence; tool arguments cannot. */
export function acpHistoryKey(history: ReturnType<typeof acpHistory>): string {
	return createHash("sha256").update(JSON.stringify(history, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}

/** Replay only when a native session starts. Compatible pending tools resume
 * with actual MCP results instead of replaying the application transcript. */
export function acpPrompt(context: TranscriptContext): PromptBlock[] {
	const blocks: PromptBlock[] = [{ type: "text", text: "The following is the saved LearnHarness conversation. Continue it as the assistant. Prior tool calls have already run; use their recorded results.\n<conversation-history>" }];
	for (const message of acpHistory(context.messages)) {
		const content = message.content.map((part) => part.type === "image" ? { type: "image", mimeType: part.mimeType, note: "Image attached below this message" } : part);
		blocks.push({ type: "text", text: JSON.stringify({ ...message, content }) });
		for (const part of message.content) if (part.type === "image") blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
	}
	blocks.push({ type: "text", text: "</conversation-history>\nContinue from the end. Use the LearnHarness MCP tools for all application actions. LearnHarness validates and executes each tool; wait for its actual result before continuing." });
	return blocks;
}

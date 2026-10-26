import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

/**
 * Cold-start transcript rendering. A local CLI conversation starts empty and
 * only accepts USER input, so when a run begins (a new learner turn, or a
 * parked run that was lost) the app's prior conversation is replayed as the
 * opening user message: one block per historical message, tagged by role,
 * with earlier tool calls and their results inline. Blocks render
 * deterministically and append-only, so consecutive cold starts share a
 * cacheable prefix.
 *
 * The trailing user input (the learner's new message) is passed as plain
 * blocks after the history, so the model answers it directly.
 */

export type PromptBlock = TextContent | ImageContent;

const PREAMBLE = [
	"The conversation so far is reproduced below, oldest first. Each earlier message is wrapped in a tag naming its author;",
	"<tool_call> and <tool_result> entries record tools you already called and what they returned.",
	"Treat it as your own conversation history: continue it as the assistant, and call your tools directly for any new tool use.",
].join(" ");

function escapeAttr(value: string): string { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

function userBlocks(message: UserMessage, wrap: boolean): PromptBlock[] {
	const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const out: PromptBlock[] = [];
	for (const part of parts) {
		if (part.type === "image") out.push({ type: "image", data: part.data, mimeType: part.mimeType });
		else if (part.text) out.push({ type: "text", text: wrap ? `<user>\n${part.text}\n</user>` : part.text });
	}
	return out;
}

function assistantBlock(message: AssistantMessage): PromptBlock | undefined {
	const lines: string[] = [];
	for (const part of message.content) {
		if (part.type === "text" && part.text.trim()) lines.push(part.text);
		else if (part.type === "toolCall") lines.push(`<tool_call id="${escapeAttr(part.id)}" name="${escapeAttr(part.name)}">${JSON.stringify(part.arguments)}</tool_call>`);
	}
	return lines.length ? { type: "text", text: `<assistant>\n${lines.join("\n")}\n</assistant>` } : undefined;
}

function toolResultBlocks(message: ToolResultMessage): PromptBlock[] {
	const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n");
	const status = message.isError ? "error" : "ok";
	const out: PromptBlock[] = [{ type: "text", text: `<tool_result id="${escapeAttr(message.toolCallId)}" name="${escapeAttr(message.toolName)}" status="${status}">\n${text}\n</tool_result>` }];
	for (const part of message.content) if (part.type === "image") out.push({ type: "image", data: part.data, mimeType: part.mimeType });
	return out;
}

/** Render a non-system message list into the opening prompt of a fresh CLI conversation. */
export function renderTranscript(messages: readonly Message[], options: { images: boolean }): PromptBlock[] {
	const conversation = messages.filter((m) => m.role !== "system");
	let tail = conversation.length;
	while (tail > 0 && conversation[tail - 1]!.role === "user") tail--;
	const history = conversation.slice(0, tail);
	const current = conversation.slice(tail) as UserMessage[];
	const blocks: PromptBlock[] = [];
	if (history.length > 0) {
		blocks.push({ type: "text", text: PREAMBLE });
		for (const message of history) {
			if (message.role === "user") blocks.push(...userBlocks(message, true));
			else if (message.role === "assistant") { const block = assistantBlock(message); if (block) blocks.push(block); }
			else if (message.role === "toolResult") blocks.push(...toolResultBlocks(message));
		}
	}
	if (current.length > 0) for (const message of current) blocks.push(...userBlocks(message, false));
	else if (history.length > 0) blocks.push({ type: "text", text: "Continue from the latest tool results above." });
	const filtered = options.images ? blocks : blocks.map((block) => block.type === "image" ? { type: "text" as const, text: `[image omitted: ${block.mimeType}]` } : block);
	return filtered.length ? filtered : [{ type: "text", text: "Continue." }];
}

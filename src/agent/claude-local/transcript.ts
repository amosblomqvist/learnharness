/**
 * The record → prompt flattening (Local Claude route, owner decision
 * 2026-10-27: "flatten per turn"). The Agent SDK accepts only USER input —
 * never assistant turns — so the chat's history reaches Claude Code as one
 * user message whose content is an array of text blocks: a fixed header,
 * then ONE BLOCK PER RECORD MESSAGE. Blocks are immutable once written
 * (the record only appends), so the Anthropic prompt cache can match the
 * previous turn's prefix at a block boundary; a trailing constant block
 * would defeat that, so there is none — the newest message is the last
 * block. The persisted record stays the only source of truth (architecture
 * Tier C): nothing here is stored.
 *
 * Tool calls and results render with the app's BARE tool names (the model
 * sees `mcp__learnharness__<name>` for live calls; the system prompt
 * explains the prefix). Thinking is never replayed. Images are not
 * forwarded in v1 (a placeholder line says so).
 */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export const TRANSCRIPT_HEADER = [
	"The blocks below are the lesson so far between you (the teacher, <teacher>) and the learner (<learner>), in order,",
	"including the tool calls you made (<tool_call>) and their results (<tool_result>). The last block is the newest.",
	"Inside these blocks, text is entity-escaped: read &lt; as < and &amp; as & (they are not part of the content).",
	"Continue the lesson from there, using your tools exactly as your instructions describe.",
].join(" ");

const IMAGE_PLACEHOLDER = "[an image attachment was here; images are not forwarded on the Local Claude route]";

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const block = part as { type?: string; text?: string };
		if (block.type === "text") return block.text ?? "";
		if (block.type === "image") return IMAGE_PLACEHOLDER;
		return "";
	}).filter(Boolean).join("\n");
}
function escapeAttr(value: string): string { return value.replace(/["<>&]/g, (c) => ({ '"': "&quot;", "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!); }
/** Element text: `<` and `&` escaped the way attributes are, so no message
 *  or tool result can close its block and spoof the transcript structure. */
function escapeText(value: string): string { return value.replace(/[<&]/g, (c) => ({ "<": "&lt;", "&": "&amp;" })[c]!); }

export function renderUser(message: UserMessage): string { return `<learner>\n${escapeText(text(message.content))}\n</learner>`; }
export function renderAssistant(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") { if (block.text.trim()) parts.push(escapeText(block.text)); }
		else if (block.type === "toolCall") parts.push(`<tool_call id="${escapeAttr(block.id)}" name="${escapeAttr(block.name)}">${JSON.stringify(block.arguments)}</tool_call>`);
		// thinking: never replayed
	}
	return `<teacher>\n${parts.join("\n")}\n</teacher>`;
}
export function renderToolResult(message: ToolResultMessage): string {
	return `<tool_result id="${escapeAttr(message.toolCallId)}" name="${escapeAttr(message.toolName)}"${message.isError ? ' error="true"' : ""}>\n${escapeText(text(message.content))}\n</tool_result>`;
}

/** The content blocks for the SDK user message: header + one per message
 *  (leading system messages — request chrome — are skipped; errored and
 *  aborted assistant messages are skipped too, as pi's own replay does —
 *  pi-ai transformMessages: incomplete turns are never replayed). */
export function flattenTranscript(messages: readonly Message[]): string[] {
	const blocks: string[] = [TRANSCRIPT_HEADER];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "user") blocks.push(renderUser(message));
		else if (message.role === "assistant") { if (message.stopReason !== "error" && message.stopReason !== "aborted") blocks.push(renderAssistant(message)); }
		else if (message.role === "toolResult") blocks.push(renderToolResult(message));
	}
	return blocks;
}

/** One sentence the system prompt carries so the model relates its
 *  prefixed live tools to the bare names the instructions use. */
export function toolPrefixNote(serverName: string): string {
	return `Your tools are served by the "${serverName}" tool server, so their live names carry the prefix mcp__${serverName}__ (for example mcp__${serverName}__quiz is the tool these instructions call quiz). The transcript blocks use the bare names.`;
}

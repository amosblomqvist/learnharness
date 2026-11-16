import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AcpPromptBlock } from "./acp-client.ts";

type ReplayPart = string | ImageContent;

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return getLabelledParts("[user]", message.content);
		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});
		case "toolResult": {
			const label = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

function toPromptBlocksFromParts(parts: ReplayPart[]): AcpPromptBlock[] {
	const blocks: AcpPromptBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) {
			blocks.push({ type: "text", text: pendingText.join("\n\n") });
			pendingText = [];
		}
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}

	flushText();
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function toUnlabelledPromptBlocks(content: string | (TextContent | ImageContent)[]): AcpPromptBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (content.length === 0) return [{ type: "text", text: "" }];
	return content.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image", data: block.data, mimeType: block.mimeType },
	);
}

/** Formats user, assistant, tool-call, and tool-result history into ACP prompt
 *  content blocks for cold-start replay, preserving text and image attachments. */
export function toAntigravityPromptBlocks(messages: Message[]): AcpPromptBlock[] {
	const conversation = messages.filter((message) => message.role !== "system");
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") {
		return toUnlabelledPromptBlocks(first.content);
	}
	return toPromptBlocksFromParts(conversation.flatMap(getReplayParts));
}

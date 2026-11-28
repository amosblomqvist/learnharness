import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): string[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	return text ? [`${label}\n${text}`] : [label];
}

function getReplayParts(message: Message): string[] {
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

export function toAgyPrompt(messages: Message[]): string {
	const systemPrompt = getCurrentSystemPrompt(messages);
	const conversation = messages.filter((message) => message.role !== "system");

	if (!systemPrompt && conversation.length === 1 && conversation[0]?.role === "user") {
		const first = conversation[0];
		if (typeof first.content === "string") return first.content;
		return first.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	}

	const parts: string[] = [];
	if (systemPrompt) {
		parts.push(`[system]\n${systemPrompt}`);
	}

	for (const message of conversation) {
		parts.push(...getReplayParts(message));
	}

	return parts.join("\n\n");
}

export function toAgyStreamJsonLine(promptText: string): string {
	return JSON.stringify({ event: "user", message: { content: promptText } });
}

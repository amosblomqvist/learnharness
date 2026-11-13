import type { Usage } from "@earendil-works/pi-ai";

export type CliUsage = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>;

export type CliBlock = { type: "text" } | { type: "thinking" } | { type: "toolUse"; id: string; name: string };

export type CliEvent =
	| { type: "messageStart"; usage: CliUsage }
	| { type: "blockStart"; index: number; block: CliBlock }
	| { type: "textDelta"; index: number; text: string }
	| { type: "thinkingDelta"; index: number; thinking: string }
	| { type: "toolInputDelta"; index: number; partialJson: string }
	| { type: "blockStop"; index: number }
	| { type: "messageDelta"; stopReason: string | null; usage: CliUsage }
	| { type: "messageStop" }
	| { type: "assistantError"; error: string; text: string }
	| { type: "resultError"; text: string }
	| { type: "toolResults"; ids: string[] };

type RawUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
};

type RawContentBlock = { type: string; id?: string; name?: string };

type RawDelta = {
	type?: string;
	text?: string;
	thinking?: string;
	partial_json?: string;
	stop_reason?: string | null;
};

type RawStreamEvent = {
	type: string;
	index?: number;
	message?: { usage?: RawUsage };
	content_block?: RawContentBlock;
	delta?: RawDelta;
	usage?: RawUsage;
};

type RawCliLine = {
	type?: string;
	event?: RawStreamEvent;
	error?: string | null;
	message?: { content?: { type: string; text?: string; tool_use_id?: string }[] };
	is_error?: boolean;
	result?: string;
	subtype?: string;
	errors?: string[];
};

function toUsage(raw: RawUsage): CliUsage {
	const usage: CliUsage = {};

	if (typeof raw.input_tokens === "number") usage.input = raw.input_tokens;
	if (typeof raw.output_tokens === "number") usage.output = raw.output_tokens;
	if (typeof raw.cache_read_input_tokens === "number") usage.cacheRead = raw.cache_read_input_tokens;
	if (typeof raw.cache_creation_input_tokens === "number") usage.cacheWrite = raw.cache_creation_input_tokens;

	return usage;
}

function toBlock(raw: RawContentBlock): CliBlock | null {
	switch (raw.type) {
		case "text":
			return { type: "text" };

		case "thinking":
			return { type: "thinking" };

		case "tool_use":
			if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
			return { type: "toolUse", id: raw.id, name: raw.name };

		default:
			return null;
	}
}

function parseDelta(index: number, delta: RawDelta): CliEvent | null {
	switch (delta.type) {
		case "text_delta":
			if (typeof delta.text !== "string") return null;
			return { type: "textDelta", index, text: delta.text };

		case "thinking_delta":
			if (typeof delta.thinking !== "string") return null;
			return { type: "thinkingDelta", index, thinking: delta.thinking };

		case "input_json_delta":
			if (typeof delta.partial_json !== "string") return null;
			return { type: "toolInputDelta", index, partialJson: delta.partial_json };

		default:
			return null;
	}
}

function parseBlockEvent(index: number, event: RawStreamEvent): CliEvent | null {
	switch (event.type) {
		case "content_block_start": {
			if (!event.content_block) return null;

			const block = toBlock(event.content_block);
			return block ? { type: "blockStart", index, block } : null;
		}

		case "content_block_delta":
			return event.delta ? parseDelta(index, event.delta) : null;

		case "content_block_stop":
			return { type: "blockStop", index };

		default:
			return null;
	}
}

function parseStreamEvent(event: RawStreamEvent): CliEvent | null {
	switch (event.type) {
		case "message_start":
			return { type: "messageStart", usage: toUsage(event.message?.usage ?? {}) };

		case "message_delta": {
			const stopReason = event.delta?.stop_reason ?? null;
			return { type: "messageDelta", stopReason, usage: toUsage(event.usage ?? {}) };
		}

		case "message_stop":
			return { type: "messageStop" };

		default:
			return event.index === undefined ? null : parseBlockEvent(event.index, event);
	}
}

function getText(line: RawCliLine): string {
	const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
	const texts = blocks.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []));

	return texts.join("\n");
}

function getResultErrorText(line: RawCliLine): string {
	if (line.result) return line.result;
	if (line.errors?.length) return line.errors.join("\n");
	return `claude CLI failed: ${line.subtype ?? "unknown error"}`;
}

export function parseCliLine(text: string): CliEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;

	const line = parsed as RawCliLine;

	switch (line.type) {
		case "stream_event":
			return line.event ? parseStreamEvent(line.event) : null;

		case "assistant":
			if (typeof line.error !== "string") return null;
			return { type: "assistantError", error: line.error, text: getText(line) };

		case "user": {
			const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
			const ids = blocks.flatMap((block) => block.type === "tool_result" && typeof block.tool_use_id === "string" ? [block.tool_use_id] : []);
			return ids.length ? { type: "toolResults", ids } : null;
		}

		case "result":
			if (line.is_error !== true) return null;
			return { type: "resultError", text: getResultErrorText(line) };

		default:
			return null;
	}
}

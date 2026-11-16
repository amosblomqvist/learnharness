import type { Api, AssistantMessage, AssistantMessageEventStream, Model, StopReason, ToolCall } from "@earendil-works/pi-ai";
import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";

import type { LhMessage } from "../../core/native-messages.ts";
import type { CliBlock, CliEvent, CliUsage } from "./events.ts";

export type TurnOutput = AssistantMessage & Pick<LhMessage, "cliContextWindow">;

export type BlockEvent = Extract<CliEvent, { type: "textDelta" | "thinkingDelta" | "toolInputDelta" | "blockStop" }>;

export function createOutput(model: Model<Api>): TurnOutput {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

export function updateUsage(output: TurnOutput, usage: CliUsage): void {
	Object.assign(output.usage, usage);

	const { input, output: outputTokens, cacheRead, cacheWrite } = output.usage;
	output.usage.totalTokens = input + outputTokens + cacheRead + cacheWrite;
}

export function setStopReason(output: TurnOutput, stopReasons: Readonly<Record<string, StopReason>>, stopReason: string): void {
	const mapped = stopReasons[stopReason];

	if (!mapped) {
		output.stopReason = "error";
		output.errorMessage = `Unhandled stop reason: ${stopReason}`;
		return;
	}

	output.stopReason = mapped;
}

/** Builds the assistant message from streamed blocks and collects the tool intents. */
export class TurnContent {
	readonly intents: ToolCall[] = [];
	private readonly contentIndexes = new Map<number, number>();
	private readonly partialJson = new Map<number, string>();
	private readonly toolBlocks = new Map<number, ToolCall>();

	constructor(private readonly stream: AssistantMessageEventStream, readonly output: TurnOutput) {}

	handle(event: BlockEvent): void {
		switch (event.type) {
			case "textDelta": this.appendText(event.index, event.text); return;
			case "thinkingDelta": this.appendThinking(event.index, event.thinking); return;
			case "toolInputDelta": this.appendToolInput(event.index, event.partialJson); return;
			case "blockStop": this.stopBlock(event.index); return;
		}
	}

	/** Opens a text or thinking block. A tool use block is tracked only through `trackTool`. */
	startBlock(index: number, block: CliBlock): void {
		const contentIndex = this.output.content.length;
		this.contentIndexes.set(index, contentIndex);
		switch (block.type) {
			case "text":
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
				return;
			case "thinking":
				this.output.content.push({ type: "thinking", thinking: "" });
				this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
				return;
		}
	}

	trackTool(index: number, id: string, name: string): void {
		this.toolBlocks.set(index, { type: "toolCall", id, name, arguments: {} });
	}

	/** Appends admitted calls as tool call blocks. */
	pushToolCalls(calls: ToolCall[]): void {
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
	}

	private appendText(index: number, text: string): void {
		const found = this.getBlock(index);
		if (found?.block.type !== "text") return;
		found.block.text += text;
		this.stream.push({ type: "text_delta", contentIndex: found.contentIndex, delta: text, partial: this.output });
	}

	private appendThinking(index: number, thinking: string): void {
		const found = this.getBlock(index);
		if (found?.block.type !== "thinking") return;
		found.block.thinking += thinking;
		this.stream.push({ type: "thinking_delta", contentIndex: found.contentIndex, delta: thinking, partial: this.output });
	}

	private appendToolInput(index: number, json: string): void {
		const found = this.getBlock(index);
		if (found?.block.type !== "toolCall") return;
		const partialJson = (this.partialJson.get(index) ?? "") + json;
		this.partialJson.set(index, partialJson);
		found.block.arguments = parseStreamingJson(partialJson);
	}

	private stopBlock(index: number): void {
		const found = this.getBlock(index);
		if (!found) return;
		const { contentIndex, block } = found;
		this.contentIndexes.delete(index);
		switch (block.type) {
			case "text":
				this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
				return;
			case "thinking":
				this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
				return;
			case "toolCall":
				Object.assign(block, parseToolCallArguments(this.partialJson.get(index) ?? ""));
				this.partialJson.delete(index);
				this.toolBlocks.delete(index);
				this.intents.push(block);
				return;
		}
	}

	private getBlock(index: number): { contentIndex: number; block: AssistantMessage["content"][number] } | null {
		const tool = this.toolBlocks.get(index);
		if (tool) return { contentIndex: -1, block: tool };
		const contentIndex = this.contentIndexes.get(index);
		if (contentIndex === undefined) return null;
		const block = this.output.content[contentIndex];
		return block ? { contentIndex, block } : null;
	}
}

import type { JsonObject } from "@earendil-works/pi-ai";

import type { CliEvent } from "../external-cli/events.ts";

/**
 * Parses the lines of `gemini --output-format stream-json` (Gemini CLI 0.68.0, read from
 * packages/cli non-interactive code in the installed bundle):
 *   init        {session_id, model}
 *   message     {role: "user" | "assistant", content, delta?: true}
 *   tool_use    {tool_name, tool_id, parameters}
 *   tool_result {tool_id, status: "success" | "error", output?, error?: {type, message}}
 *   error       {severity: "warning" | "error", message}
 *   result      {status: "success" | "error", stats?, error?: {type, message}}
 * The stream has no message boundaries, so the mapper makes them: one message from the first
 * content until a result, or until the tool calls collected so far end it for their results.
 */
export const GeminiLineType = {
	INIT: "init",
	MESSAGE: "message",
	TOOL_USE: "tool_use",
	TOOL_RESULT: "tool_result",
	ERROR: "error",
	RESULT: "result",
} as const;

/** `role` of a message line. */
export const GeminiRole = { ASSISTANT: "assistant" } as const;
/** `severity` of an error line. */
export const GeminiSeverity = { ERROR: "error" } as const;
/** `status` of a result line. */
export const GeminiResultStatus = { ERROR: "error" } as const;

type OpenBlock ={ kind: "text"; index: number };

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GeminiEventParser {
	private messageOpen = false;
	private nextIndex = 0;
	private block: OpenBlock | undefined;
	private toolBatchOpen = false;

	/** Tool calls were mapped and no event has closed the batch yet. */
	get collecting(): boolean { return this.toolBatchOpen; }

	/** The events of one stdout line. Throws on a line that is not a JSON object (the output is malformed). */
	parse(line: string): CliEvent[] {
		const value: unknown = JSON.parse(line);
		if (!isObject(value)) throw new Error("stream-json line is not an object");
		const head = this.toolBatchOpen && value.type !== GeminiLineType.TOOL_USE ? this.endToolBatch() : [];
		return [...head, ...this.map(value)];
	}

	/** Ends the message that carries the tool calls collected so far; it stops for their results. */
	endToolBatch(): CliEvent[] {
		if (!this.toolBatchOpen) return [];
		const events: CliEvent[] = [...this.closeBlock(), { type: "messageDelta", stopReason: "tool_use", usage: {} }, { type: "messageStop" }];
		this.reset();
		return events;
	}

	private map(line: JsonObject): CliEvent[] {
		switch (line.type) {
			case GeminiLineType.MESSAGE:
				return line.role === GeminiRole.ASSISTANT ? this.text(str(line.content)) : [];
			case GeminiLineType.TOOL_USE:
				return this.toolUse(str(line.tool_id), str(line.tool_name), isObject(line.parameters) ? line.parameters : {});
			case GeminiLineType.TOOL_RESULT: {
				const id = str(line.tool_id);
				return id ? [{ type: "toolResults", ids: [id] }] : [];
			}
			case GeminiLineType.ERROR:
				return line.severity === GeminiSeverity.ERROR ? [{ type: "resultError", text: str(line.message) || "Gemini CLI reported an error" }] : [];
			case GeminiLineType.RESULT:
				return line.status === GeminiResultStatus.ERROR
					? [{ type: "resultError", text: str((line.error as JsonObject | undefined)?.message) || "Gemini CLI reported an error" }]
					: this.finish();
			default:
				return [];
		}
	}

	private text(value: string): CliEvent[] {
		if (!value) return [];
		const events: CliEvent[] = [];
		if (!this.block) {
			events.push(...this.ensureMessage());
			this.block = { kind: "text", index: this.nextIndex++ };
			events.push({ type: "blockStart", index: this.block.index, block: { type: "text" } });
		}
		events.push({ type: "textDelta", index: this.block.index, text: value });
		return events;
	}

	private toolUse(id: string, name: string, args: JsonObject): CliEvent[] {
		if (!id || !name) throw new Error("tool_use without a tool_id or tool_name");
		const events = [...this.closeBlock(), ...this.ensureMessage()];
		const index = this.nextIndex++;
		this.toolBatchOpen = true;
		events.push(
			{ type: "blockStart", index, block: { type: "toolUse", id, name } },
			{ type: "toolInputDelta", index, partialJson: JSON.stringify(args) },
			{ type: "blockStop", index },
		);
		return events;
	}

	private finish(): CliEvent[] {
		const events: CliEvent[] = [...this.closeBlock(), ...this.ensureMessage(), { type: "messageDelta", stopReason: "end_turn", usage: {} }, { type: "messageStop" }];
		this.reset();
		return events;
	}

	private ensureMessage(): CliEvent[] {
		if (this.messageOpen) return [];
		this.messageOpen = true;
		return [{ type: "messageStart", usage: {} }];
	}

	private closeBlock(): CliEvent[] {
		if (!this.block) return [];
		const { index } = this.block;
		this.block = undefined;
		return [{ type: "blockStop", index }];
	}

	private reset(): void {
		this.messageOpen = false;
		this.nextIndex = 0;
		this.block = undefined;
		this.toolBatchOpen = false;
	}
}

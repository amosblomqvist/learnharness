import type { Api, AssistantMessage, AssistantMessageEventStream, Model, ToolCall } from "@earendil-works/pi-ai";

import { ToolUseKind, type CliAdapter } from "./adapter.ts";
import type { CliBlock, CliEvent } from "./events.ts";
import { createOutput, setStopReason, TurnContent, updateUsage, type TurnOutput } from "./turn-content.ts";

export const ABORT_MESSAGE = "Request was aborted";
const REFUSAL_MESSAGE = "The model refused to complete the request";

export type TurnAdapter = Pick<CliAdapter, "texts" | "stopReasons" | "classifyToolUse" | "assistantErrorMessage">;

/** Turns CLI events of one pi turn into pi's assistant message events. */
export class CliTurn {
	private readonly content: TurnContent;
	/** The current message called a harness tool the CLI rejects itself (RETRY_BARE). */
	skippedBareCall = false;
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
		private readonly harnessToolNames: ReadonlySet<string>,
		private readonly adapter: TurnAdapter,
	) {
		this.content = new TurnContent(stream, createOutput(model));
	}

	private get output(): TurnOutput { return this.content.output; }

	handle(event: CliEvent): void {
		if (this.finished) return;
		switch (event.type) {
			case "messageStart":
				this.skippedBareCall = false;
				updateUsage(this.output, event.usage);
				this.start();
				return;
			case "blockStart": this.startBlock(event.index, event.block); return;
			case "textDelta":
			case "thinkingDelta":
			case "toolInputDelta":
			case "blockStop": this.content.handle(event); return;
			case "messageDelta":
				updateUsage(this.output, event.usage);
				if (event.stopReason) setStopReason(this.output, this.adapter.stopReasons, event.stopReason);
				return;
			// Tool intent is not execution admission. The process publishes only
			// calls that actually reach the call channel.
			case "messageStop": if (this.output.stopReason !== "toolUse") this.finish(); return;
			case "assistantError": this.fail(this.adapter.assistantErrorMessage(event.error, event.text), "error"); return;
			case "resultError": this.fail(event.text, "error"); return;
		}
	}

	get waitingForAdmission(): boolean { return !this.finished && this.output.stopReason === "toolUse"; }

	getIntents(): ToolCall[] { return this.content.intents; }

	getMessage(): AssistantMessage { return this.output; }

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined) this.output.cliContextWindow = tokens;
	}

	admit(calls: ToolCall[]): void {
		this.start();
		this.content.pushToolCalls(calls);
		this.output.stopReason = "toolUse";
		this.finish();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private startBlock(index: number, block: CliBlock): void {
		this.content.startBlock(index, block);
		if (block.type !== "toolUse") return;
		const verdict = this.adapter.classifyToolUse(block.name, this.harnessToolNames);
		switch (verdict.kind) {
			case ToolUseKind.HARNESS: this.content.trackTool(index, block.id, verdict.name); return;
			case ToolUseKind.RETRY_BARE: this.skippedBareCall = true; return;
			case ToolUseKind.NATIVE: this.fail(this.adapter.texts.nativeToolCall, "error"); return;
		}
	}

	private finish(): void {
		const { stopReason } = this.output;
		if (stopReason === "error") { this.fail(this.output.errorMessage ?? REFUSAL_MESSAGE, "error"); return; }
		if (stopReason === "pending" || stopReason === "aborted") { this.fail(this.output.errorMessage ?? this.adapter.texts.noStopReason, "error"); return; }
		this.finished = true;
		this.stream.push({ type: "done", reason: stopReason, message: this.output });
		this.stream.end();
	}
}

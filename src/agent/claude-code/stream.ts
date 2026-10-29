import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";
import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";

import { externalCliEnv } from "../../core/auth-env.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { ClaudeLaunchError, createClaudeLauncher } from "./launch.ts";
import { parseCliLine, type CliBlock, type CliEvent, type CliUsage } from "./cli-events.ts";
import { ClaudeCodeError } from "./constants.ts";
import { ContextWindowProbe } from "./context-window.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "./live-processes.ts";
import { configurationForReuse, conversationForReuse } from "./reuse-context.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, toolNameFromMcp, type PendingToolCall, type ToolBridge } from "./tool-bridge.ts";
import { toClaudeInput, toStreamJsonLine } from "./transcript.ts";

type RunClaudeOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type ClaudeChild = ChildProcessWithoutNullStreams | null;
export type RunClaude = (args: string[], options: RunClaudeOptions) => ClaudeChild | Promise<ClaudeChild>;

// A held MCP call lasts until pi calls back with the tool result, which for a question tool is
// whenever the learner answers; this must outlast the live-process idle timeout so the CLI never
// times out first.
const MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

const PRIVATE_FILE_MODE = 0o600;

const EFFORTS: Record<ThinkingLevel, AnthropicEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	pause_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	tool_use: "toolUse",
	refusal: "error",
};

const REFUSAL_MESSAGE = "The model refused to complete the request";
const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "claude CLI failed to start";
const NO_STOP_REASON_MESSAGE = "claude CLI ended the message without a stop reason";
const NOT_SIGNED_IN_ERROR = "authentication_failed";

export function toEffort(level: ThinkingLevel | undefined): AnthropicEffort {
	return level ? EFFORTS[level] : "medium";
}

type ClaudeArgsInput = {
	model: string;
	effort: AnthropicEffort;
	systemPromptFile: string;
	mcpConfigFile: string;
	allowedTools: string[];
};

export function toClaudeArgs(input: ClaudeArgsInput): string[] {
	return [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		input.model,
		"--effort",
		input.effort,
		"--system-prompt-file",
		input.systemPromptFile,
		"--tools",
		"",
		"--strict-mcp-config",
		"--mcp-config",
		input.mcpConfigFile,
		"--setting-sources",
		"user",
		"--settings",
		JSON.stringify({ disableAllHooks: true }),
		"--disable-slash-commands",
		"--no-session-persistence",
		"--permission-prompts",
		"none",
		...(input.allowedTools.length > 0 ? ["--allowedTools", input.allowedTools.join(",")] : []),
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
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

function getAssistantErrorMessage(error: string, text: string): string {
	return error === NOT_SIGNED_IN_ERROR ? ClaudeCodeError.NotSignedIn : text || error;
}

class ClaudeTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private readonly contentIndexes = new Map<number, number>();
	private readonly partialJson = new Map<number, string>();
	private readonly toolBlocks = new Map<number, ToolCall>();
	private readonly intents: ToolCall[] = [];
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	handle(event: CliEvent): void {
		if (this.finished) return;

		switch (event.type) {
			case "messageStart":
				this.updateUsage(event.usage);
				this.start();
				return;

			case "blockStart":
				this.startBlock(event.index, event.block);
				return;

			case "textDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "text") return;

				block.text += event.text;
				this.stream.push({ type: "text_delta", contentIndex, delta: event.text, partial: this.output });
				return;
			}

			case "thinkingDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "thinking") return;

				block.thinking += event.thinking;
				this.stream.push({ type: "thinking_delta", contentIndex, delta: event.thinking, partial: this.output });
				return;
			}

			case "toolInputDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { block } = found;
				if (block.type !== "toolCall") return;

				const partialJson = (this.partialJson.get(event.index) ?? "") + event.partialJson;
				this.partialJson.set(event.index, partialJson);
				block.arguments = parseStreamingJson(partialJson);
				return;
			}

			case "blockStop":
				this.stopBlock(event.index);
				return;

			case "messageDelta":
				this.updateUsage(event.usage);
				if (event.stopReason) this.setStopReason(event.stopReason);
				return;

			case "messageStop":
				// Tool intent is not execution admission. The process publishes only
				// calls that actually reach the authenticated MCP bridge.
				if (this.output.stopReason !== "toolUse") this.finish();
				return;

			case "assistantError":
				this.fail(getAssistantErrorMessage(event.error, event.text), "error");
				return;

			case "resultError":
				this.fail(event.text, "error");
				return;
		}
	}

	get waitingForAdmission(): boolean { return !this.finished && this.output.stopReason === "toolUse"; }

	getIntents(): ToolCall[] { return this.intents; }

	getMessage(): AssistantMessage { return this.output; }

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined) this.output.cliContextWindow = tokens;
	}

	admit(calls: ToolCall[]): void {
		this.start();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
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

			case "toolUse":
				if (!block.name.startsWith(`mcp__${BRIDGE_SERVER_NAME}__`)) {
					this.fail("claude CLI emitted an unsupported native tool call", "error");
					return;
				}
				this.toolBlocks.set(index, { type: "toolCall", id: block.id, name: toolNameFromMcp(block.name), arguments: {} });
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

	private updateUsage(usage: CliUsage): void {
		Object.assign(this.output.usage, usage);

		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	private setStopReason(stopReason: string): void {
		const mapped = STOP_REASONS[stopReason];

		if (!mapped) {
			this.output.stopReason = "error";
			this.output.errorMessage = `Unhandled stop reason: ${stopReason}`;
			return;
		}

		this.output.stopReason = mapped;
	}

	private finish(): void {
		const { stopReason } = this.output;

		if (stopReason === "error") {
			this.fail(this.output.errorMessage ?? REFUSAL_MESSAGE, "error");
			return;
		}

		if (stopReason === "pending" || stopReason === "aborted") {
			this.fail(this.output.errorMessage ?? NO_STOP_REASON_MESSAGE, "error");
			return;
		}

		this.finished = true;
		this.stream.push({ type: "done", reason: stopReason, message: this.output });
		this.stream.end();
	}
}

type TurnFiles = { cwd: string; privateDir: string; systemPromptFile: string; mcpConfigFile: string };

async function createTurnFiles(systemPrompt: string, mcpConfig: string): Promise<TurnFiles> {
	const cwd = await mkdtemp(join(tmpdir(), "claude-code-cwd-"));
	let privateDir: string | undefined;
	try {
		privateDir = await mkdtemp(join(tmpdir(), "claude-code-private-"));
		const systemPromptFile = join(privateDir, "system-prompt.md");
		const mcpConfigFile = join(privateDir, "mcp.json");
		await writeFile(systemPromptFile, systemPrompt, { mode: PRIVATE_FILE_MODE });
		await writeFile(mcpConfigFile, mcpConfig, { mode: PRIVATE_FILE_MODE });
		return { cwd, privateDir, systemPromptFile, mcpConfigFile };
	} catch (error) {
		await Promise.all([rm(cwd, { recursive: true, force: true }), ...(privateDir ? [rm(privateDir, { recursive: true, force: true })] : [])]);
		throw error;
	}
}

async function removeTurnResources(bridge: ToolBridge, files: TurnFiles): Promise<void> {
	await Promise.all([
		bridge.close(),
		rm(files.cwd, { recursive: true, force: true }),
		rm(files.privateDir, { recursive: true, force: true }),
	]);
}

class ClaudeProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private sourceCalls: ToolCall[] = [];
	private sourceComplete = false;
	private admitted: PendingToolCall[] = [];
	private readonly cancelledIds = new Set<string>();
	private pendingError: string | undefined;
	private contextWindow: number | undefined;
	private contextProbe: ContextWindowProbe | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private turn: ClaudeTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {}

	start(stdinLine: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`claude CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("claude CLI process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("claude CLI stdin closed early:", error));
		this.contextProbe = new ContextWindowProbe(
			(line) => this.child.stdin.write(`${line}\n`),
			() => { if (!this.stopping) this.child.stdin.write(`${stdinLine}\n`); },
			(tokens) => { this.contextWindow = tokens; this.turn.setContextWindow(tokens); },
		);
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try { this.handleLine(line); }
			catch { this.fail("claude CLI emitted malformed stream output"); }
		});
		this.setSignal(signal);
		if (!this.stopping) this.contextProbe.start();
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: ClaudeTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.sourceComplete = this.sourceCalls.length > 0;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.flushAdmissions();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.contextProbe?.close();
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		// A parallel request can fail after the admitted slice was handed to
		// Pi. Retain that failure for its continuation instead of silently
		// replaying and hiding the compatibility error.
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this);
	}

	consumeFailure(owner: symbol, turn: ClaudeTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: PendingToolCall): void {
		this.cancelledIds.add(call.id);
		// Already admitted work belongs to Pi and cannot be undone. A queued
		// request, however, must never become executable after cancellation.
		this.sourceCalls = this.sourceCalls.filter((intent) => intent.id !== call.id);
	}

	/** Only authenticated MCP requests, never stdout intent alone, admit side effects. */
	flushAdmissions(): void {
		if (this.stopping || this.turn.finished || !this.sourceComplete) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;
		const calls: ToolCall[] = [];
		for (const call of pending) {
			const intent = this.sourceCalls.find((candidate) => candidate.id === call.id);
			if (!intent || intent.name !== call.name || !isDeepStrictEqual(intent.arguments, call.arguments)) {
				this.fail("claude CLI compatibility error: MCP call does not match its streamed tool intent");
				return;
			}
			calls.push(intent);
		}
		this.sourceCalls = this.sourceCalls.filter((call) => !pending.some((admitted) => admitted.id === call.id));
		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		this.turn.admit(calls);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope: return the batch, then use fresh replay.
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		if (this.contextProbe?.handle(JSON.parse(line))) return;
		const event = parseCliLine(line);
		if (!event) return;
		if (event.type === "toolResults") {
			if (event.ids.some((id) => this.sourceCalls.some((call) => call.id === id))) {
				this.fail("claude CLI refused a harness tool call before MCP admission");
			}
			return;
		}
		// Moving on before held calls were answered means the CLI did not
		// honor this tool wait. Never execute further stdout-only intentions.
		if (this.turn.finished) {
			this.fail("claude CLI moved on while harness tool calls were waiting for results");
			return;
		}
		if (event.type === "messageStart" && this.sourceComplete && this.sourceCalls.length > 0) {
			this.fail("claude CLI moved on without admitting its harness tool calls");
			return;
		}
		if (event.type === "messageStart") this.contextProbe?.refresh();
		this.turn.handle(event);
		if (this.turn.finished) { this.kill(); return; }
		if (event.type === "messageStop" && this.turn.waitingForAdmission) {
			const intents = this.turn.getIntents();
			if (intents.length === 0 || new Set(intents.map((call) => call.id)).size !== intents.length) {
				this.fail("claude CLI emitted an invalid tool batch");
				return;
			}
			this.sourceCalls = intents.filter((call) => !this.cancelledIds.has(call.id));
			this.sourceComplete = true;
			this.flushAdmissions();
		}
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		this.contextProbe?.close();
		clearTimeout(this.killTimer);
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (this.stderr.trim()) console.error("claude CLI stderr:", this.stderr.trim());
		this.turn.fail(message, "error");
		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("claude CLI cleanup failed:", error);
		});
	}
}

function continueLiveProcess(turn: ClaudeTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof ClaudeProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

function toClaudeEnv(): NodeJS.ProcessEnv {
	// Preserve native CLI auth/routing, including launch-environment credentials.
	// Claude Code chooses the account and billing method, not LearnHarness.
	return { ...externalCliEnv(), MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) };
}

async function startProcess(
	runClaude: RunClaude,
	turn: ClaudeTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toClaudeInput(context.messages);
	let cliProcess: ClaudeProcess | undefined;
	const bridge = await createToolBridge(input.tools, {
		onCall: () => cliProcess?.flushAdmissions(),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.cancelCall(call),
	});
	let files: TurnFiles;
	try {
		files = await createTurnFiles(input.systemPrompt, bridge.mcpConfig);
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await removeTurnResources(bridge, files);
		return;
	}

	let child: ChildProcessWithoutNullStreams | null;
	try {
		const args = toClaudeArgs({
			model: model.id,
			effort: toEffort(options?.reasoning),
			systemPromptFile: files.systemPromptFile,
			mcpConfigFile: files.mcpConfigFile,
			allowedTools: bridge.allowedTools,
		});
		child = await runClaude(args, { cwd: files.cwd, env, signal: options?.signal });
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(ClaudeCodeError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	cliProcess = new ClaudeProcess(child, bridge, files, turn, owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	cliProcess.start(toStreamJsonLine(input.userContent), options?.signal);
}

export function createClaudeCodeStreamFunction(runClaude: RunClaude): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("claude-code stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new ClaudeTurn(stream, model);

		const env = toClaudeEnv();
		// An existing child must not retain stale authentication/routing after env changes.
		const configuration = { request: configurationForReuse(model, context, toEffort(options?.reasoning)), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runClaude, turn, model, context, options, owner, configuration, env).catch((error: unknown) => {
			console.error("claude CLI turn failed:", error);
			turn.fail(options?.signal?.aborted ? ABORT_MESSAGE : error instanceof ClaudeLaunchError ? error.message : START_FAILED_MESSAGE, options?.signal?.aborted ? "aborted" : "error");
		});

		return stream;
	};
}

export const streamClaudeCode = createClaudeCodeStreamFunction(createClaudeLauncher());

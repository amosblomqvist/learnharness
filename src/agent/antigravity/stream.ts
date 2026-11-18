import type { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	type ToolResultMessage,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel as AgentThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { LhMessage } from "../../core/native-messages.ts";
import {
	formatAntigravityError,
	spawnAcpClient,
	type AcpClient,
	type AcpConfigOption,
	type AcpPermissionRequestParams,
	type AcpPromptResponse,
	type AcpSessionUpdate,
} from "./acp-client.ts";
import { ANTIGRAVITY_CANCEL_GRACE_MS } from "./constants.ts";
import { resolveAntigravityRuntimeSync, type ResolvedAntigravityRuntime } from "./installation.ts";
import {
	findParkedAntigravityProcess,
	parkAntigravityProcess,
	registerActiveAntigravityProcess,
	shutdownAntigravityProcesses,
	unparkAntigravityProcess,
	unregisterActiveAntigravityProcess,
	type LiveAntigravityProcess,
} from "./live-processes.ts";
import {
	findModelConfigOption,
	findThoughtLevelConfigOption,
} from "./models-discovery.ts";
import {
	buildAntigravityEnvironment,
	ensureAntigravityProfile,
	isAntigravityProfileSignedIn,
} from "./profile.ts";
import { configurationForReuse, conversationForReuse } from "./reuse-context.ts";
import {
	ANTIGRAVITY_MCP_SERVER_NAME,
	createAntigravityToolBridge,
	type AntigravityPendingToolCall,
	type AntigravityToolBridge,
} from "./tool-bridge.ts";
import {
	EMPTY_RESPONSE_ERROR_MESSAGE,
	EMPTY_RESPONSE_RETRY_PROMPT,
	isEmptyThinkingOnlyStop,
} from "../empty-response-guard.ts";
import { toAntigravityPromptBlocks } from "./transcript.ts";

export { shutdownAntigravityProcesses, toAntigravityPromptBlocks };

const ABORT_MESSAGE = "Request was aborted";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Authorizes `session/request_permission` strictly for declared tools on
 *  LearnHarness's own loopback MCP server (`learnharness`), denying native
 *  Antigravity tools, undeclared tool names, and external MCP servers. */
export function isDeclaredLearnHarnessMcpPermission(
	params: AcpPermissionRequestParams,
	declaredToolNames: ReadonlySet<string>,
	expectedSessionId?: string | null,
): boolean {
	if (expectedSessionId && typeof params.sessionId === "string" && params.sessionId !== expectedSessionId) {
		return false;
	}
	const meta = isPlainRecord(params.toolCall?._meta) ? params.toolCall._meta : null;
	if (!meta || meta.is_mcp_tool_call !== true) return false;
	const mcp = isPlainRecord(meta.mcp) ? meta.mcp : null;
	if (!mcp || mcp.server !== ANTIGRAVITY_MCP_SERVER_NAME) return false;
	return typeof mcp.tool === "string" && declaredToolNames.has(mcp.tool);
}

function createOutput(model: Model<Api>): AssistantMessage & Pick<LhMessage, "cliContextWindow"> {
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

function mapStopReason(stopReason: string | undefined): Extract<StopReason, "length" | "error" | "aborted" | "stop"> {
	switch (stopReason) {
		case "max_tokens":
		case "max_turn_requests":
			return "length";
		case "refusal":
		case "error":
			return "error";
		case "cancelled":
			return "aborted";
		case "end_turn":
		case undefined:
		default:
			return "stop";
	}
}

function resolveThoughtLevelValue(model: Model<Api>, reasoning: ThinkingLevel | undefined): string | null {
	const map = model.thinkingLevelMap as Partial<Record<AgentThinkingLevel, string | null>> | undefined;
	if (!map) return null;
	const target: AgentThinkingLevel = reasoning ?? "off";
	const mapped = map[target];
	return typeof mapped === "string" && mapped.trim() ? mapped.trim() : null;
}

class AcpTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private activeBlock: { kind: "thinking" | "text"; contentIndex: number } | null = null;
	started = false;
	finished = false;
	lastError: string | null = null;
	private lastUsageUpdateUsed = 0;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
		private readonly platform: NodeJS.Platform,
	) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage {
		return this.output;
	}

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined) {
			this.output.cliContextWindow = tokens;
		}
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeActiveBlock(): void {
		if (!this.activeBlock) return;
		const { kind, contentIndex } = this.activeBlock;
		this.activeBlock = null;
		const block = this.output.content[contentIndex];
		if (!block) return;

		if (kind === "thinking" && block.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: this.output,
			});
		} else if (kind === "text" && block.type === "text") {
			this.stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: this.output,
			});
		}
	}

	handleSessionUpdate(update: AcpSessionUpdate, stderrTail: string): void {
		if (this.finished) return;

		switch (update.sessionUpdate) {
			case "agent_thought_chunk": {
				const content = update.content as { type?: unknown; text?: unknown } | undefined;
				if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) return;
				this.start();
				if (this.activeBlock?.kind === "text") {
					this.closeActiveBlock();
				}
				if (this.activeBlock?.kind !== "thinking") {
					const contentIndex = this.output.content.length;
					this.output.content.push({ type: "thinking", thinking: "" });
					this.activeBlock = { kind: "thinking", contentIndex };
					this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
				}
				const block = this.output.content[this.activeBlock.contentIndex];
				if (block?.type === "thinking") {
					block.thinking += content.text;
					this.stream.push({
						type: "thinking_delta",
						contentIndex: this.activeBlock.contentIndex,
						delta: content.text,
						partial: this.output,
					});
				}
				return;
			}

			case "agent_message_chunk": {
				const content = update.content as { type?: unknown; text?: unknown } | undefined;
				if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) return;
				this.start();
				if (this.activeBlock?.kind === "thinking") {
					this.closeActiveBlock();
				}
				if (this.activeBlock?.kind !== "text") {
					const contentIndex = this.output.content.length;
					this.output.content.push({ type: "text", text: "" });
					this.activeBlock = { kind: "text", contentIndex };
					this.stream.push({ type: "text_start", contentIndex, partial: this.output });
				}
				const block = this.output.content[this.activeBlock.contentIndex];
				if (block?.type === "text") {
					block.text += content.text;
					this.stream.push({
						type: "text_delta",
						contentIndex: this.activeBlock.contentIndex,
						delta: content.text,
						partial: this.output,
					});
				}
				return;
			}

			case "usage_update": {
				const size = update.size;
				if (typeof size === "number" && Number.isFinite(size) && size > 0) {
					this.output.cliContextWindow = Math.round(size);
				}
				const used = update.used;
				if (typeof used === "number" && Number.isFinite(used) && used > 0) {
					const rounded = Math.round(used);
					this.lastUsageUpdateUsed = rounded;
					// MCP tool-use steps finish via admit() before session/prompt returns PromptResponse.usage.
					// Populate usage.input so measuredContextTokens and turns logs reflect single-call context size.
					this.output.usage.input = rounded;
					this.output.usage.totalTokens = rounded;
				}
				return;
			}

			case "error": {
				const raw =
					typeof update.message === "string"
						? update.message
						: typeof update.error === "string"
							? update.error
							: "Antigravity reported a stream error.";
				const formatted = formatAntigravityError(raw, stderrTail, this.platform);
				this.lastError = formatted;
				this.fail(formatted, "error");
				return;
			}

			case "state_update": {
				const errText =
					typeof update.error === "string"
						? update.error
						: typeof update.message === "string"
							? update.message
							: null;
				if (errText) {
					this.lastError = formatAntigravityError(errText, stderrTail, this.platform);
				}
				return;
			}

			// tool_call / tool_call_update are informational only; side effects require authenticated MCP admission.
			default:
				return;
		}
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeActiveBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finished = true;
		this.stream.push({ type: "done", reason: "toolUse", message: this.output });
		this.stream.end();
	}

	prepareForRetry(): void {
		if (!this.finished) {
			this.closeActiveBlock();
		}
	}

	applyPromptUsage(response: AcpPromptResponse): void {
		if (!response.usage) return;
		const u = response.usage;
		// agy_acp_server reports uncached prompt_token_count in inputTokens (already disjoint from cachedReadTokens).
		const input = typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0;
		const output = typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? u.outputTokens : 0;
		const cacheRead =
			typeof u.cachedReadTokens === "number" && Number.isFinite(u.cachedReadTokens) ? u.cachedReadTokens : 0;
		const cacheWrite =
			typeof u.cachedWriteTokens === "number" && Number.isFinite(u.cachedWriteTokens) ? u.cachedWriteTokens : 0;
		const thought = typeof u.thoughtTokens === "number" && Number.isFinite(u.thoughtTokens) ? u.thoughtTokens : 0;
		const bucketSum = input + output + cacheRead + cacheWrite;
		// PromptResponse.usage is cumulative across all model calls since session/prompt started, whereas
		// usage_update.used reports the single latest call's context usage. If bucketSum exceeds lastUsageUpdateUsed,
		// PromptResponse spans multiple calls; keep the single-call usage_update measurement for Context (last call).
		if (this.lastUsageUpdateUsed === 0 || bucketSum <= this.lastUsageUpdateUsed) {
			const total =
				typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens)
					? u.totalTokens
					: bucketSum + thought;
			this.output.usage = {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: total,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
	}

	finishPrompt(response: AcpPromptResponse): void {
		if (this.finished) return;
		this.start();
		this.closeActiveBlock();
		this.applyPromptUsage(response);

		const mapped = mapStopReason(response.stopReason);
		if (mapped === "aborted") {
			this.fail(ABORT_MESSAGE, "aborted");
			return;
		}
		if (mapped === "error") {
			this.fail(this.lastError ?? "Antigravity refused to complete the request.", "error");
			return;
		}

		this.output.stopReason = mapped;
		this.finished = true;
		this.stream.push({ type: "done", reason: mapped, message: this.output });
		this.stream.end();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.closeActiveBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}
}

class AcpSessionProcess implements LiveAntigravityProcess {
	toolCallIds: string[] = [];
	private client: AcpClient | null = null;
	private acpSessionId: string | null = null;
	private bridge: AntigravityToolBridge | null = null;
	private runDir: string | null = null;
	private admitted: AntigravityPendingToolCall[] = [];
	private stopping = false;
	private closed = false;
	private cleanupPromise: Promise<void> | null = null;
	private signal: AbortSignal | undefined;
	private pendingError: string | undefined;
	private completedResponse: AcpPromptResponse | undefined;
	private contextWindow: number | undefined;

	constructor(
		private turn: AcpTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
		private readonly platform: NodeJS.Platform,
		private readonly cancelGraceMs: number,
	) {}

	async start(input: {
		runtime: ResolvedAntigravityRuntime;
		model: Model<Api>;
		context: TranscriptContext;
		options: SimpleStreamOptions | undefined;
		profileDir: string;
		baseEnv: Record<string, string | undefined>;
		spawnProcess?: typeof spawn;
	}): Promise<void> {
		registerActiveAntigravityProcess(this);
		this.setSignal(input.options?.signal);
		if (this.stopping) {
			await this.cleanup(true);
			return;
		}

		const tools = getCurrentTools(input.context.messages);
		const systemPrompt = getCurrentSystemPrompt(input.context.messages);
		const promptBlocks = toAntigravityPromptBlocks(input.context.messages);

		const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-turn-"));
		const cwd = path.join(runDir, "cwd");
		const tempDir = path.join(runDir, "tmp");
		fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
		fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
		this.runDir = runDir;

		const bridge = await createAntigravityToolBridge(tools, {
			onCall: () => this.flushAdmissions(),
			onError: (err) => this.fail(err.message),
			onCancel: (call) => this.handleCancelledToolCall(call),
		});
		if (this.stopping || this.closed) {
			await bridge.close().catch(() => {});
			await this.cleanup(true);
			return;
		}
		this.bridge = bridge;

		const env = buildAntigravityEnvironment({
			baseEnv: input.baseEnv,
			geminiHome: input.profileDir,
			tempDir,
			harnessPath: input.runtime.harnessPath,
			platform: this.platform,
		});

		let latestConfigOptions: AcpConfigOption[] | undefined;
		const declaredToolNames = new Set(tools.map((tool) => tool.name));

		const client = spawnAcpClient({
			cwd,
			env,
			runtime: input.runtime,
			profileDir: input.profileDir,
			platform: this.platform,
			spawnProcess: input.spawnProcess,
			approvePermission: (params) =>
				isDeclaredLearnHarnessMcpPermission(params, declaredToolNames, this.acpSessionId),
			onSessionUpdate: (_sid, update) => {
				if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
					latestConfigOptions = update.configOptions;
				}
				if (update.sessionUpdate === "usage_update") {
					const size = update.size;
					if (typeof size === "number" && Number.isFinite(size) && size > 0) {
						this.contextWindow = Math.round(size);
					}
				}
				if (this.turn.finished && update.sessionUpdate === "error") {
					const raw =
						typeof update.message === "string"
							? update.message
							: typeof update.error === "string"
								? update.error
								: "Antigravity reported a stream error.";
					this.fail(formatAntigravityError(raw, client.stderrTail(), this.platform));
					return;
				}
				if (
					this.turn.finished &&
					this.admitted.length > 0 &&
					(update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "agent_message_chunk")
				) {
					// Antigravity moved on with model generation instead of honoring the held MCP call wait.
					// Kill and unpark immediately so the next turn cold-starts cleanly with transcript replay.
					void this.kill();
					return;
				}
				this.turn.handleSessionUpdate(update, client.stderrTail());
			},
			onError: (err) => {
				this.fail(err.message);
			},
			onClose: (code, signal, stderrTail) => {
				if (this.stopping || this.closed) return;
				const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-300)}` : "";
				const msg = formatAntigravityError(
					`Antigravity exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "null"}`})${detail}`,
					stderrTail,
					this.platform,
				);
				this.fail(msg);
			},
		});
		if (this.stopping || this.closed) {
			await client.close({ eofGraceMs: this.cancelGraceMs }).catch(() => {});
			await this.cleanup(true);
			return;
		}
		this.client = client;

		try {
			await client.initialize();
			if (this.stopping) return;

			const sessionResult = await client.sessionNew({
				cwd,
				mcpServers: [bridge.toAcpMcpServer()],
				systemPromptAppend: systemPrompt,
				disabledTools: ["run_workflow"],
			});
			this.acpSessionId = sessionResult.sessionId;
			if (this.stopping) return;

			let configOptions = Array.isArray(sessionResult.configOptions)
				? sessionResult.configOptions
				: (latestConfigOptions ?? []);

			const modelOpt = findModelConfigOption(configOptions);
			if (modelOpt) {
				const modelSetRes = await client.setConfigOption(sessionResult.sessionId, modelOpt.configId, input.model.id);
				if (Array.isArray(modelSetRes.configOptions)) {
					configOptions = modelSetRes.configOptions;
				} else if (latestConfigOptions) {
					configOptions = latestConfigOptions;
				}
			} else {
				try {
					const modelSetRes = await client.setConfigOption(sessionResult.sessionId, "model", input.model.id);
					if (Array.isArray(modelSetRes.configOptions)) {
						configOptions = modelSetRes.configOptions;
					}
				} catch {
					// If server omits configOptions and does not implement set_config_option, allow prompt to continue.
				}
			}
			if (this.stopping) return;

			const thoughtValue = resolveThoughtLevelValue(input.model, input.options?.reasoning);
			if (thoughtValue !== null) {
				const thoughtOpt = findThoughtLevelConfigOption(configOptions);
				if (thoughtOpt) {
					await client.setConfigOption(sessionResult.sessionId, thoughtOpt.configId, thoughtValue);
				}
			}
			if (this.stopping) return;

			let response = await client.prompt(sessionResult.sessionId, promptBlocks);
			if (this.stopping) return;

			if (!this.turn.finished && isEmptyThinkingOnlyStop(mapStopReason(response.stopReason), this.turn.getMessage())) {
				this.turn.prepareForRetry();
				response = await client.prompt(sessionResult.sessionId, [
					{ type: "text", text: EMPTY_RESPONSE_RETRY_PROMPT },
				]);
				if (this.stopping) return;
			}

			if (!this.turn.finished) {
				if (isEmptyThinkingOnlyStop(mapStopReason(response.stopReason), this.turn.getMessage())) {
					this.turn.applyPromptUsage(response);
					this.turn.fail(EMPTY_RESPONSE_ERROR_MESSAGE, "error");
					await this.cleanup();
				} else {
					this.turn.finishPrompt(response);
					await this.cleanup();
				}
			} else if (this.admitted.length > 0) {
				// Antigravity ended the prompt while LearnHarness was parked waiting on admitted tool results.
				// Tear down instead of caching completedResponse so the next turn cold-starts cleanly with replay.
				await this.kill();
			} else {
				// Prompt completed right while handing off a tool batch or parked; keep response for continuation.
				this.completedResponse = response;
			}
		} catch (error) {
			if (this.stopping) return;
			const raw = error instanceof Error ? error.message : String(error);
			const formatted = formatAntigravityError(raw, client.stderrTail(), this.platform);
			this.fail(formatted);
		}
	}

	canContinue(
		owner: symbol,
		sessionId: string | undefined,
		configuration: unknown,
		messages: Message[],
		results: ToolResultMessage[],
	): boolean {
		const conversation = conversationForReuse(messages);
		return (
			!this.stopping &&
			!this.closed &&
			owner === this.owner &&
			!!sessionId &&
			sessionId === this.sessionId &&
			isDeepStrictEqual(configuration, this.configuration) &&
			isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation) &&
			conversation.length === this.conversation.length + this.admitted.length &&
			results.length === this.admitted.length &&
			new Set(results.map((result) => result.toolCallId)).size === results.length &&
			this.admitted.every((call) =>
				results.some((result) => result.toolCallId === call.id && result.toolName === call.name),
			)
		);
	}

	consumeFailure(owner: symbol, turn: AcpTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		unparkAntigravityProcess(this);
		turn.fail(message, "error");
		void this.cleanup();
		return true;
	}

	continueTurn(
		turn: AcpTurn,
		messages: Message[],
		results: ToolResultMessage[],
		signal: AbortSignal | undefined,
	): void {
		unparkAntigravityProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.setSignal(signal);
		if (this.stopping) return;

		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge?.resolveToolCall(call, result);
		}

		if (this.completedResponse && (this.bridge?.getPendingToolCalls().length ?? 0) === 0) {
			const response = this.completedResponse;
			this.completedResponse = undefined;
			this.turn.finishPrompt(response);
			void this.cleanup();
			return;
		}

		this.flushAdmissions();
	}

	private handleCancelledToolCall(call: AntigravityPendingToolCall): void {
		if (this.stopping || this.closed) return;
		if (this.admitted.some((admittedCall) => admittedCall.id === call.id)) {
			// The MCP HTTP call was cancelled or timed out on Antigravity's side while parked;
			// unpark and terminate so the next turn replays the tool result into a fresh ACP session.
			void this.kill();
		}
	}

	flushAdmissions(): void {
		if (this.stopping || this.closed || this.turn.finished || !this.bridge) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;

		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		const toolCalls: ToolCall[] = pending.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments,
		}));
		this.turn.admit(toolCalls);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) {
			parkAntigravityProcess(this);
		} else {
			// No trusted sessionId scope: return the tool batch, then cold-start with replay.
			void this.kill();
		}
	}

	fail(message: string): void {
		if (this.stopping) return;
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) {
			this.pendingError = message;
			void this.cleanupResources(false);
			parkAntigravityProcess(this);
			return;
		}
		this.turn.fail(message, "error");
		void this.cleanup();
	}

	kill(): Promise<void> {
		if (this.stopping && this.cleanupPromise) return this.cleanupPromise;
		this.stopping = true;
		unparkAntigravityProcess(this);
		this.signal?.removeEventListener("abort", this.onAbort);
		if (this.client && this.acpSessionId && !this.client.isClosed()) {
			try {
				this.client.cancel(this.acpSessionId);
			} catch {
				// ignore cancel write error
			}
		}
		return this.cleanup(true);
	}

	forceCleanupSync(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopping = true;
		unregisterActiveAntigravityProcess(this);
		this.signal?.removeEventListener("abort", this.onAbort);
		if (this.bridge) {
			const bridge = this.bridge;
			this.bridge = null;
			try {
				bridge.closeSync();
			} catch {
				// ignore
			}
		}
		if (this.client) {
			const client = this.client;
			this.client = null;
			const child = client.child;
			try {
				child.stdin?.end();
			} catch {
				// ignore
			}
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {
					// ignore
				}
			}
		}
		if (this.runDir) {
			const dir = this.runDir;
			this.runDir = null;
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}

	private readonly onAbort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		void this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.onAbort);
		this.signal = signal;
		signal?.addEventListener("abort", this.onAbort, { once: true });
		if (signal?.aborted) this.onAbort();
	}

	private cleanup(forceGrace = false): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.stopping = true;
		unparkAntigravityProcess(this);
		unregisterActiveAntigravityProcess(this);
		this.cleanupPromise = this.cleanupResources(forceGrace);
		return this.cleanupPromise;
	}

	private async cleanupResources(forceGrace: boolean): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.stopping = true;
		this.signal?.removeEventListener("abort", this.onAbort);

		const tasks: Promise<unknown>[] = [];
		if (this.bridge) {
			const bridge = this.bridge;
			this.bridge = null;
			tasks.push(bridge.close().catch(() => {}));
		}
		if (this.client) {
			const client = this.client;
			this.client = null;
			tasks.push(
				client
					.close({
						eofGraceMs: forceGrace ? this.cancelGraceMs : 400,
					})
					.catch(() => {}),
			);
		}
		await Promise.allSettled(tasks);
		if (this.runDir) {
			const dir = this.runDir;
			this.runDir = null;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
}

export interface AntigravityStreamDeps {
	isEnabled?: () => boolean;
	binaryPath?: () => string | undefined;
	resolveRuntime?: (binaryPath?: string) => ResolvedAntigravityRuntime | null;
	isSignedIn?: () => boolean;
	ensureProfile?: () => string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	spawnProcess?: typeof spawn;
	cancelGraceMs?: number;
}

export function createAntigravityStream(
	deps: AntigravityStreamDeps = {},
): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity stream owner");
	const platform = deps.platform ?? process.platform;
	const cancelGraceMs = deps.cancelGraceMs ?? ANTIGRAVITY_CANCEL_GRACE_MS;

	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AcpTurn(stream, model, platform);

		const findMatchingParked = () => {
			const assistantIndex = context.messages.findLastIndex((m) => m.role === "assistant");
			const assistant = context.messages[assistantIndex];
			if (assistant?.role !== "assistant") return null;
			const ids = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
			const existing = findParkedAntigravityProcess(ids, owner, options?.sessionId);
			return existing instanceof AcpSessionProcess ? { existing, assistantIndex } : null;
		};

		if (options?.signal?.aborted) {
			const match = findMatchingParked();
			if (match) void match.existing.kill();
			turn.fail(ABORT_MESSAGE, "aborted");
			return stream;
		}

		if (deps.isEnabled && !deps.isEnabled()) {
			const match = findMatchingParked();
			if (match) void match.existing.kill();
			turn.fail("Antigravity is disabled. Enable it in Settings → Providers.", "error");
			return stream;
		}

		const baseEnv = deps.env ?? process.env;
		const signedIn = deps.isSignedIn ? deps.isSignedIn() : isAntigravityProfileSignedIn({ env: baseEnv });
		if (!signedIn) {
			const match = findMatchingParked();
			if (match) void match.existing.kill();
			turn.fail("Antigravity is not signed in. Sign in with Google in Settings → Providers.", "error");
			return stream;
		}

		const binPath = deps.binaryPath?.();
		const runtime = deps.resolveRuntime
			? deps.resolveRuntime(binPath)
			: resolveAntigravityRuntimeSync({ binaryPath: binPath, env: baseEnv, platform });
		if (!runtime) {
			const match = findMatchingParked();
			if (match) void match.existing.kill();
			turn.fail("Antigravity runtime could not be found. Install or configure it in Settings → Providers.", "error");
			return stream;
		}

		const profileDir = deps.ensureProfile
			? deps.ensureProfile()
			: ensureAntigravityProfile({ env: baseEnv, platform });

		const configuration = configurationForReuse(model, context, options?.reasoning, runtime, profileDir);

		// Check if a parked ACP process is waiting on LearnHarness tool execution.
		const match = findMatchingParked();
		if (match) {
			if (match.existing.consumeFailure(owner, turn)) return stream;
			const trailing = context.messages.slice(match.assistantIndex + 1);
			const results = trailing.filter((m): m is ToolResultMessage => m.role === "toolResult");
			if (
				trailing.length === results.length &&
				match.existing.canContinue(owner, options?.sessionId, configuration, context.messages, results)
			) {
				match.existing.continueTurn(turn, context.messages, results, options?.signal);
				return stream;
			}
			void match.existing.kill();
		}

		const proc = new AcpSessionProcess(
			turn,
			owner,
			options?.sessionId,
			configuration,
			structuredClone(conversationForReuse(context.messages)),
			platform,
			cancelGraceMs,
		);

		void proc
			.start({
				runtime,
				model,
				context,
				options,
				profileDir,
				baseEnv,
				spawnProcess: deps.spawnProcess,
			})
			.catch((error: unknown) => {
				const msg = error instanceof Error ? error.message : String(error);
				turn.fail(formatAntigravityError(msg, "", platform), options?.signal?.aborted ? "aborted" : "error");
			});

		return stream;
	};
}

export const streamAntigravity = createAntigravityStream();

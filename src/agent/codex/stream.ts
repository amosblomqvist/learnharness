import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Api, JsonObject, Model, SimpleStreamOptions, StopReason, StreamFunction, ThinkingLevel, ToolResultMessage } from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { CODEX_MINIMUM_VERSION } from "../../core/contracts/codex.ts";
import { getCliBinary, type CliBinarySpec } from "../claude-code/binary.ts";
import { readCliVersion, type CliVersionSpec, type ReadCliVersion } from "../claude-code/installation.ts";
import { CliLaunchError, createCliLauncher } from "../claude-code/launch.ts";
import { toClaudeInput, type ClaudeContentBlock } from "../claude-code/transcript.ts";
import {
	ToolUseKind,
	type CliAdapter,
	type CliLaunch,
	type CliSession,
	type CliTexts,
	type HeldCall,
	type LaunchInput,
	type RunCli,
	type SessionIo,
	type ToolUseVerdict,
} from "../external-cli/adapter.ts";
import { matchById } from "../external-cli/call-matching.ts";
import { createCliStreamFunction } from "../external-cli/cli-process.ts";
import type { CliEvent } from "../external-cli/events.ts";
import { isNativeRequest, parseRpcLine, RpcClient, RpcMethod, TurnMapper, type RpcId } from "./app-server.ts";

export type RunCodex = RunCli;

export { CODEX_MINIMUM_VERSION };

export const codexVersionSpec: CliVersionSpec = {
	versionPattern: /^codex-cli (\d+)\.(\d+)\.(\d+)$/,
	minimumVersion: CODEX_MINIMUM_VERSION,
};

export const codexBinarySpec: CliBinarySpec = {
	windowsNames: ["codex.exe"],
	posixNames: ["codex"],
	knownDirs: ({ env, platform, homeDir }, paths) => platform === "win32"
		? [
			paths.join(env.LOCALAPPDATA ?? paths.join(homeDir, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin"),
			env.npm_config_prefix ?? paths.join(env.APPDATA ?? paths.join(homeDir, "AppData", "Roaming"), "npm"),
		]
		: [
			paths.join(homeDir, ".local", "bin"),
			env.npm_config_prefix ? paths.join(env.npm_config_prefix, "bin") : paths.join(homeDir, ".npm-global", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
		],
	// Direct spawn uses no shell, so npm's .cmd-only installation cannot run.
	excludedExtensions: [".cmd", ".bat"],
};

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createCodexLauncher({
	findBinary = () => getCliBinary(codexBinarySpec),
	readVersion = readCliVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadCliVersion;
	spawnProcess?: typeof spawn;
} = {}): RunCodex {
	return createCliLauncher({ name: "Codex", version: codexVersionSpec }, { findBinary, readVersion, spawnProcess });
}

/** Feature names from `codex features list`: Codex's own tools, connectors, memory and hooks stay off. */
const DISABLED_FEATURES = [
	"shell_tool", "unified_exec", "view_image", "apps", "browser_use", "browser_use_external",
	"computer_use", "image_generation", "memories", "plugins", "hooks",
];

export function toCodexArgs(): string[] {
	return [
		"app-server",
		...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
		"-c", 'web_search="disabled"',
		"-c", "project_doc_max_bytes=0",
		"-c", "include_apps_instructions=false",
	];
}

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	tool_use: "toolUse",
};

const CODEX_TEXTS: CliTexts = {
	label: "codex CLI",
	startFailed: "codex CLI failed to start",
	noStopReason: "codex CLI ended the message without a stop reason",
	nativeToolCall: "codex CLI emitted an unsupported native tool call",
	malformedOutput: "codex CLI emitted malformed app-server output",
	callMismatch: "codex CLI compatibility error: tool call does not match its streamed tool intent",
	refusedBeforeAdmission: "codex CLI refused a harness tool call before admission",
	movedOnWhileWaiting: "codex CLI moved on while harness tool calls were waiting for results",
	movedOnWithoutAdmitting: "codex CLI moved on without admitting its harness tool calls",
	invalidToolBatch: "codex CLI emitted an invalid tool batch",
	cliNotFound: "codex CLI was not found",
};

const METHOD_NOT_FOUND = -32601;

function toCodexEnv(): NodeJS.ProcessEnv {
	// Codex owns its sign-in and routing; LearnHarness-only keys never reach it.
	return externalCliEnv();
}

function classifyToolUse(name: string, harnessToolNames: ReadonlySet<string>): ToolUseVerdict {
	return harnessToolNames.has(name) ? { kind: ToolUseKind.HARNESS, name } : { kind: ToolUseKind.NATIVE };
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toDataUrl(mimeType: string, data: string): string {
	return `data:${mimeType};base64,${data}`;
}

function toUserInput(content: ClaudeContentBlock[]): object[] {
	return content.map((block) => block.type === "text"
		? { type: "text", text: block.text, text_elements: [] }
		: { type: "image", url: toDataUrl(block.source.media_type, block.source.data) });
}

function toContentItems(result: ToolResultMessage): object[] {
	return result.content.map((block) => block.type === "text"
		? { type: "inputText", text: block.text }
		: { type: "inputImage", imageUrl: toDataUrl(block.mimeType, block.data) });
}

type SessionSetup = {
	model: string;
	/** The Codex effort for this turn; undefined leaves the choice to Codex. */
	effort: string | undefined;
	cwd: string;
	systemPrompt: string;
	dynamicTools: object[];
	userInput: object[];
	onError(error: Error): void;
};

/** Where the tool calls of the current pi message stand. */
const BatchPhase = {
	/** No tool call is open. */
	IDLE: "idle",
	/** Calls are being collected into one message; it ends after TOOL_BATCH_WINDOW_MS. */
	COLLECTING: "collecting",
	/** The message is with pi; calls that arrive now wait for its results. */
	SENT: "sent",
} as const;
type BatchPhase = (typeof BatchPhase)[keyof typeof BatchPhase];

/**
 * Codex sends no marker for the end of a batch of parallel dynamic tool calls, so calls that
 * arrive this soon after the first one share its pi message.
 */
const TOOL_BATCH_WINDOW_MS = 30;

/** Notifications that carry no content of their own and may arrive while calls are being collected. */
const QUIET_METHODS: ReadonlySet<string> = new Set<string>([RpcMethod.ITEM_STARTED, RpcMethod.ITEM_COMPLETED]);

/**
 * initialize, then config/read (to learn which user MCP servers and plugins to switch off for this
 * thread), then thread/start, then turn/start. Tool calls are server requests held by callId
 * until pi hands back the result. Calls that arrive together are one pi message; a call that
 * arrives after pi has the message waits and becomes the next message once its results are sent.
 */
function openSession(io: SessionIo, setup: SessionSetup): CliSession {
	const rpc = new RpcClient((line) => { if (!io.stopping()) io.write(line); });
	const mapper = new TurnMapper();
	/** The calls of the message pi has (or is about to get). */
	const pending: HeldCall[] = [];
	/** Calls that arrived after the message went to pi. */
	const queued: HeldCall[] = [];
	const requestIds = new Map<string, RpcId>();
	let phase: BatchPhase = BatchPhase.IDLE;
	let batchTimer: ReturnType<typeof setTimeout> | undefined;

	const step = (onResult: (result: JsonObject) => void) => (response: { result?: unknown; error?: { message: string } }) => {
		if (response.error) { setup.onError(new Error(`codex app-server request failed: ${response.error.message}`)); return; }
		onResult((response.result ?? {}) as JsonObject);
	};

	const startTurn = (threadId: string) => rpc.request(
			RpcMethod.TURN_START,
			{ threadId, input: setup.userInput, model: setup.model, ...(setup.effort === undefined ? {} : { effort: setup.effort }) },
			step(() => {}),
		);

	const startThread = (config: JsonObject) => rpc.request(RpcMethod.THREAD_START, {
		cwd: setup.cwd,
		ephemeral: true,
		sandbox: "read-only",
		approvalPolicy: "never",
		model: setup.model,
		baseInstructions: setup.systemPrompt,
		dynamicTools: setup.dynamicTools,
		config: {
			mcp_servers: Object.fromEntries(Object.keys((config.mcp_servers ?? {}) as JsonObject).map((name) => [name, { enabled: false }])),
			plugins: Object.fromEntries(Object.keys((config.plugins ?? {}) as JsonObject).map((id) => [id, { enabled: false }])),
		},
	}, step((result) => startTurn(str((result.thread as JsonObject | undefined)?.id))));

	const endBatch = (): readonly CliEvent[] => {
		clearTimeout(batchTimer);
		batchTimer = undefined;
		phase = BatchPhase.SENT;
		return mapper.endToolBatch();
	};

	/** The results are back: the calls that arrived meanwhile become the next message. */
	const releaseQueued = () => {
		phase = BatchPhase.IDLE;
		if (queued.length === 0) return;
		const calls = queued.splice(0);
		pending.push(...calls);
		io.emit([...calls.flatMap((call) => mapper.toolCall(call.id, call.name, call.arguments)), ...endBatch()]);
	};

	const addCall = (held: HeldCall): readonly CliEvent[] => {
		if (phase === BatchPhase.SENT) { queued.push(held); return []; }
		pending.push(held);
		const events = mapper.toolCall(held.id, held.name, held.arguments);
		if (phase === BatchPhase.IDLE) {
			phase = BatchPhase.COLLECTING;
			batchTimer = setTimeout(() => { if (!io.stopping()) io.emit(endBatch()); }, TOOL_BATCH_WINDOW_MS);
		}
		return events;
	};

	return {
		channel: {
			pending: () => [...pending],
			resolve: (call, result) => {
				const rpcId = requestIds.get(call.id);
				pending.splice(0, pending.length, ...pending.filter((held) => held.id !== call.id));
				requestIds.delete(call.id);
				if (rpcId !== undefined) rpc.respond(rpcId, { contentItems: toContentItems(result), success: !result.isError });
				if (pending.length === 0 && phase === BatchPhase.SENT) releaseQueued();
			},
		},
		begin: () => rpc.request(RpcMethod.INITIALIZE, { clientInfo: { name: "learnharness", version: "1" }, capabilities: { experimentalApi: true } }, step(() => {
			rpc.notify(RpcMethod.INITIALIZED);
			rpc.request(RpcMethod.CONFIG_READ, { cwd: setup.cwd }, step((result) => startThread((result.config ?? {}) as JsonObject)));
		})),
		readLine: (line) => {
			const message = parseRpcLine(line);
			if (message.kind === "response") { rpc.handleResponse(message); return []; }
			if (message.kind === "notification") {
				// Anything but a quiet notification ends the collecting of calls.
				const head = phase === BatchPhase.COLLECTING && !QUIET_METHODS.has(message.method) ? endBatch() : [];
				return [...head, ...mapper.notification(message.method, message.params)];
			}
			if (message.method === RpcMethod.TOOL_CALL) {
				const callId = str(message.params.callId);
				const tool = str(message.params.tool);
				if (!callId || !tool) throw new Error(`${RpcMethod.TOOL_CALL} without a callId or tool`);
				const args = (typeof message.params.arguments === "object" && message.params.arguments !== null && !Array.isArray(message.params.arguments) ? message.params.arguments : {}) as JsonObject;
				requestIds.set(callId, message.id);
				return addCall({ id: callId, name: tool, arguments: args });
			}
			// Never leave a server request unanswered. Codex's own tools are refused and fail the turn.
			rpc.respondError(message.id, METHOD_NOT_FOUND, `LearnHarness does not support ${message.method}`);
			return isNativeRequest(message.method) ? mapper.nativeAttempt(message.method) : [];
		},
		onMessageStart: () => {},
		close: () => { clearTimeout(batchTimer); batchTimer = undefined; },
	};
}

/**
 * The pi thinking level, mapped through the model's thinkingLevelMap (built from the efforts Codex
 * advertises). No level, or a level the model maps to nothing, sends no effort at all.
 */
export function toCodexEffort(model: Pick<Model<Api>, "thinkingLevelMap">, level: ThinkingLevel | undefined): string | undefined {
	if (!level) return undefined;
	return model.thinkingLevelMap?.[level] || undefined;
}

async function launch({ model, context, options, hooks }: LaunchInput): Promise<CliLaunch> {
	// The CLI keeps no session across processes: a fresh process replays the whole transcript.
	const input = toClaudeInput(context.messages);
	const cwd = await mkdtemp(join(tmpdir(), "codex-cwd-"));
	const setup: Omit<SessionSetup, "onError"> = {
		model: model.id,
		effort: toCodexEffort(model, options?.reasoning),
		cwd,
		systemPrompt: input.systemPrompt,
		dynamicTools: input.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })),
		userInput: toUserInput(input.userContent),
	};

	return {
		args: toCodexArgs(),
		cwd,
		open: (io) => openSession(io, { ...setup, onError: hooks.onError }),
		dispose: () => rm(cwd, { recursive: true, force: true }),
	};
}

const codexAdapter: CliAdapter = {
	ownerName: "codex stream owner",
	texts: CODEX_TEXTS,
	stopReasons: STOP_REASONS,
	matcher: matchById,
	env: toCodexEnv,
	// reuseEffort gets no model; the model is already part of the reuse key, so the raw level
	// separates exactly the turns that send different efforts (and a few that send the same one).
	reuseEffort: (options: SimpleStreamOptions | undefined) => options?.reasoning ?? "default",
	classifyToolUse,
	assistantErrorMessage: (error, text) => text || error,
	startErrorMessage: (error) => error instanceof CliLaunchError ? error.message : CODEX_TEXTS.startFailed,
	launch,
};

export function createCodexStreamFunction(runCodex: RunCodex): StreamFunction<Api, SimpleStreamOptions> {
	return createCliStreamFunction(codexAdapter, runCodex);
}

export const streamCodex = createCodexStreamFunction(createCodexLauncher());

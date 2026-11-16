import { spawn } from "node:child_process";

import type { Api, Message, SimpleStreamOptions, StopReason, StreamFunction } from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { GEMINI_NODE_MISSING_MESSAGE } from "../../core/contracts/external-cli.ts";
import { GEMINI_CLI_MINIMUM_VERSION } from "../../core/contracts/gemini-cli.ts";
import { readCliVersionWith, type CliVersionSpec, type ReadCliVersion } from "../claude-code/installation.ts";
import { CliLaunchError, createCliLauncher, type CliCommand } from "../claude-code/launch.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, ToolCallKeyKind, type ToolBridge } from "../claude-code/tool-bridge.ts";
import { toClaudeInput } from "../claude-code/transcript.ts";
import {
	ToolUseKind,
	type CliAdapter,
	type CliLaunch,
	type CliSession,
	type CliTexts,
	type LaunchInput,
	type RunCli,
	type SessionIo,
	type ToolUseVerdict,
} from "../external-cli/adapter.ts";
import { matchInOrder } from "../external-cli/call-matching.ts";
import { createCliStreamFunction } from "../external-cli/cli-process.ts";
import { createTurnDirs, removeTurnDirs, type TurnDirs } from "../external-cli/turn-files.ts";
import { findGeminiBinary, findNodeBinary, GEMINI_NO_RELAUNCH_ENV, isGeminiBundleScript } from "./binary.ts";
import { GeminiEventParser } from "./events.ts";

export type RunGemini = RunCli;

export { GEMINI_CLI_MINIMUM_VERSION };

export const geminiVersionSpec: CliVersionSpec = {
	versionPattern: /^(\d+)\.(\d+)\.(\d+)$/,
	minimumVersion: GEMINI_CLI_MINIMUM_VERSION,
};

export const NODE_MISSING_MESSAGE = GEMINI_NODE_MISSING_MESSAGE;

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createGeminiLauncher({
	findBinary = findGeminiBinary,
	findNode = findNodeBinary,
	readVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	findNode?: () => string | null;
	readVersion?: ReadCliVersion;
	spawnProcess?: typeof spawn;
} = {}): RunGemini {
	// The official bundle script (gemini.js) runs as `node gemini.js ...`, for the version check and for the turn.
	const commandFor = (binary: string): CliCommand => {
		if (!isGeminiBundleScript(binary)) return { file: binary, leadingArgs: [] };
		const node = findNode();
		if (!node) throw new CliLaunchError(NODE_MISSING_MESSAGE);
		return { file: node, leadingArgs: [binary] };
	};
	return createCliLauncher({ name: "Gemini CLI", version: geminiVersionSpec }, {
		// Checked here, before the version is read, so a missing Node.js is named and not reported as an unreadable version.
		findBinary: () => {
			const binary = findBinary();
			if (binary) commandFor(binary);
			return binary;
		},
		readVersion: readVersion ?? ((binary) => { const command = commandFor(binary); return readCliVersionWith(command.file, command.leadingArgs, GEMINI_NO_RELAUNCH_ENV); }),
		spawnProcess,
		commandFor,
	});
}

// A held MCP call lasts until pi calls back with the tool result (for a question tool, whenever
// the learner answers), so the server's request timeout must outlast the live-process idle timeout.
const MCP_TOOL_TIMEOUT_MS = 30 * 60_000;
/** Gemini CLI reads this long after the last tool_use for more of the same batch. */
const TOOL_BATCH_WINDOW_MS = 30;

const PRIVATE_FILE_MODE = 0o600;
const TURN_DIR_PREFIX = "gemini-cli";
const SYSTEM_PROMPT_FILE = "system.md";
const SETTINGS_FILE = "settings.json";
/** A context file name no user has, so `~/.gemini/GEMINI.md` and project context files are not loaded. */
const NO_CONTEXT_FILE = "learnharness-no-context-file.md";

/** Gemini CLI names a tool of MCP server `s` as `mcp_<s>_<tool>`, always; its own tools never start with `mcp_`. */
export const MCP_NAME_PREFIX = `mcp_${BRIDGE_SERVER_NAME}_`;
/** `--allowed-mcp-server-names` and `mcp.allowed` take the server alias. */
const ALLOWED_MCP_SERVER = BRIDGE_SERVER_NAME;

/** Gemini CLI's own tools (ALL_BUILTIN_TOOL_NAMES of 0.68.0). Excluded by name; a call from any other name still fails the turn. */
export const GEMINI_BUILTIN_TOOLS = [
	"glob", "write_todos", "write_file", "google_web_search", "web_fetch", "replace", "run_shell_command", "grep_search",
	"read_many_files", "read_file", "list_directory", "activate_skill", "ask_user", "tracker_create_task", "tracker_update_task",
	"tracker_get_task", "tracker_list_tasks", "tracker_add_dependency", "tracker_visualize", "get_internal_docs", "enter_plan_mode",
	"exit_plan_mode", "update_topic", "complete_task", "invoke_agent", "read_mcp_resource", "list_mcp_resources",
];

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	tool_use: "toolUse",
};

const GEMINI_TEXTS: CliTexts = {
	label: "gemini CLI",
	startFailed: "gemini CLI failed to start",
	noStopReason: "gemini CLI ended the message without a stop reason",
	nativeToolCall: "gemini CLI emitted an unsupported native tool call",
	malformedOutput: "gemini CLI emitted malformed stream output",
	callMismatch: "gemini CLI compatibility error: MCP call does not match its streamed tool intent",
	refusedBeforeAdmission: "gemini CLI refused a harness tool call before MCP admission",
	movedOnWhileWaiting: "gemini CLI moved on while harness tool calls were waiting for results",
	movedOnWithoutAdmitting: "gemini CLI moved on without admitting its harness tool calls",
	invalidToolBatch: "gemini CLI emitted an invalid tool batch",
	cliNotFound: "gemini CLI was not found",
};

type GeminiArgsInput = { model: string };

/** The prompt goes in on stdin (it is read to its end), the system prompt and settings through env files. */
export function toGeminiArgs(input: GeminiArgsInput): string[] {
	return [
		"--output-format", "stream-json",
		"--model", input.model,
		"--extensions", "none",
		"--allowed-mcp-server-names", ALLOWED_MCP_SERVER,
		"--skip-trust",
	];
}

function toGeminiEnv(): NodeJS.ProcessEnv {
	// Gemini CLI owns its sign-in and routing; LearnHarness-only keys never reach it.
	// GEMINI_CLI_NO_RELAUNCH: the bundle must not start a copy of itself that an abort would leave behind.
	return { ...externalCliEnv(), ...GEMINI_NO_RELAUNCH_ENV };
}

type BridgeServer = { url: string; headers: Record<string, string> };

function readBridgeServer(mcpConfig: string): BridgeServer {
	const server = (JSON.parse(mcpConfig) as { mcpServers: Record<string, BridgeServer> }).mcpServers[BRIDGE_SERVER_NAME];
	if (!server) throw new Error("tool bridge config has no server");
	return server;
}

/**
 * The system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH, which overrides user and project
 * settings): only the LearnHarness MCP server, trusted so its calls need no confirmation;
 * Gemini's own tools allowed by no list and excluded by name.
 * `tools.core` is not left empty: an empty allowlist adds a deny-all rule that outranks the
 * trusted-server rule, which would hide the LearnHarness tools too. It lists only that server.
 */
export function toGeminiSettings(bridge: BridgeServer): string {
	return JSON.stringify({
		mcpServers: { [BRIDGE_SERVER_NAME]: { httpUrl: bridge.url, headers: bridge.headers, trust: true, timeout: MCP_TOOL_TIMEOUT_MS } },
		mcp: { allowed: [ALLOWED_MCP_SERVER] },
		tools: { core: [`${MCP_NAME_PREFIX}*`], exclude: GEMINI_BUILTIN_TOOLS },
		context: { fileName: [NO_CONTEXT_FILE], includeDirectoryTree: false },
	});
}

function classifyToolUse(name: string, harnessToolNames: ReadonlySet<string>): ToolUseVerdict {
	// Not "a name in the built-in list": anything that is not a tool of the LearnHarness server is native.
	if (!name.startsWith(MCP_NAME_PREFIX)) return { kind: ToolUseKind.NATIVE };
	const bare = name.slice(MCP_NAME_PREFIX.length);
	return harnessToolNames.has(bare) ? { kind: ToolUseKind.HARNESS, name: bare } : { kind: ToolUseKind.NATIVE };
}

export const IMAGE_UNSUPPORTED_MESSAGE = "Gemini CLI provider cannot read images. Remove the image or switch the model.";
const IMAGE_OMITTED = "[image omitted]";

/** The headless input is text only: an image of an earlier message is named in its place in the text. */
function toPrompt(content: ReturnType<typeof toClaudeInput>["userContent"]): string {
	return content.map((block) => (block.type === "text" ? block.text : IMAGE_OMITTED)).join("\n\n");
}

/** The learner's newest message is this turn's input; an image there cannot be passed on, so the turn stops. */
function hasImage(message: Message | undefined): boolean {
	return message?.role === "user" && typeof message.content !== "string" && message.content.some((block) => block.type === "image");
}

/** stdin is the prompt, closed after it; stdout is the stream-json lines. */
function openSession(io: SessionIo, prompt: string, bridge: ToolBridge): CliSession {
	const parser = new GeminiEventParser();
	let batchTimer: ReturnType<typeof setTimeout> | undefined;
	const stopTimer = () => { clearTimeout(batchTimer); batchTimer = undefined; };
	return {
		channel: {
			pending: () => bridge.getPendingToolCalls(),
			resolve: (call, result) => bridge.resolveToolCall(call, result),
		},
		begin: () => {
			io.write(prompt);
			io.endInput();
		},
		readLine: (line) => {
			const events = parser.parse(line);
			stopTimer();
			// The stream has no end-of-batch marker: tool calls that follow each other closely are one message.
			if (parser.collecting) batchTimer = setTimeout(() => { batchTimer = undefined; if (!io.stopping()) io.emit(parser.endToolBatch()); }, TOOL_BATCH_WINDOW_MS);
			return events;
		},
		onMessageStart: () => {},
		close: stopTimer,
	};
}

async function launch({ model, context, hooks }: LaunchInput): Promise<CliLaunch> {
	if (hasImage(context.messages.findLast((message) => message.role === "user"))) throw new CliLaunchError(IMAGE_UNSUPPORTED_MESSAGE);
	// The CLI is started per turn without a session: a fresh process replays the whole transcript.
	const input = toClaudeInput(context.messages);
	// MCP requests carry no call id: the bridge gives each its own, and calls are matched by name and arguments.
	const bridge = await createToolBridge(input.tools, hooks, { callKey: () => ({ kind: ToolCallKeyKind.UNKEYED }) });
	return finishLaunch(bridge, input, model.id);
}

async function finishLaunch(bridge: ToolBridge, input: ReturnType<typeof toClaudeInput>, model: string): Promise<CliLaunch> {
	let dirs: TurnDirs<typeof SYSTEM_PROMPT_FILE | typeof SETTINGS_FILE>;
	try {
		dirs = await createTurnDirs(TURN_DIR_PREFIX, { [SYSTEM_PROMPT_FILE]: input.systemPrompt, [SETTINGS_FILE]: toGeminiSettings(readBridgeServer(bridge.mcpConfig)) }, PRIVATE_FILE_MODE);
	} catch (error) {
		await bridge.close();
		throw error;
	}
	return {
		args: toGeminiArgs({ model }),
		cwd: dirs.cwd,
		env: { GEMINI_SYSTEM_MD: dirs.files[SYSTEM_PROMPT_FILE], GEMINI_CLI_SYSTEM_SETTINGS_PATH: dirs.files[SETTINGS_FILE] },
		open: (io) => openSession(io, toPrompt(input.userContent), bridge),
		dispose: async () => { await Promise.all([bridge.close(), removeTurnDirs(dirs)]); },
	};
}

const geminiAdapter: CliAdapter = {
	ownerName: "gemini-cli stream owner",
	texts: GEMINI_TEXTS,
	stopReasons: STOP_REASONS,
	matcher: matchInOrder,
	env: toGeminiEnv,
	reuseEffort: (options: SimpleStreamOptions | undefined) => options?.reasoning ?? "default",
	classifyToolUse,
	assistantErrorMessage: (error, text) => text || error,
	startErrorMessage: (error) => error instanceof CliLaunchError ? error.message : GEMINI_TEXTS.startFailed,
	launch,
};

export function createGeminiCliStreamFunction(run: RunGemini): StreamFunction<Api, SimpleStreamOptions> {
	return createCliStreamFunction(geminiAdapter, run);
}

export const streamGeminiCli = createGeminiCliStreamFunction(createGeminiLauncher());

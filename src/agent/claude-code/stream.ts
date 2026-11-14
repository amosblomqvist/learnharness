import type { SimpleStreamOptions, StopReason, StreamFunction, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";

import { externalCliEnv } from "../../core/auth-env.ts";
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
import { matchById } from "../external-cli/call-matching.ts";
import { createCliStreamFunction } from "../external-cli/cli-process.ts";
import { createTurnDirs, removeTurnDirs, type TurnDirs } from "../external-cli/turn-files.ts";
import { ClaudeLaunchError, createClaudeLauncher } from "./launch.ts";
import { parseCliLine } from "./cli-events.ts";
import { ClaudeCodeError } from "./constants.ts";
import { ContextWindowProbe } from "./context-window.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, toolNameFromMcp, type ToolBridge } from "./tool-bridge.ts";
import { toClaudeInput, toStreamJsonLine } from "./transcript.ts";

export type RunClaude = RunCli;

// A held MCP call lasts until pi calls back with the tool result, which for a question tool is
// whenever the learner answers; this must outlast the live-process idle timeout so the CLI never
// times out first.
// A held call sends no progress, so the CLI's separate idle timeout (300 s by default) needs
// the same bound, or it aborts an unanswered question first.
const MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

const PRIVATE_FILE_MODE = 0o600;
const TURN_DIR_PREFIX = "claude-code";
const SYSTEM_PROMPT_FILE = "system-prompt.md";
const MCP_CONFIG_FILE = "mcp.json";

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

const NOT_SIGNED_IN_ERROR = "authentication_failed";

const CLAUDE_TEXTS: CliTexts = {
	label: "claude CLI",
	startFailed: "claude CLI failed to start",
	noStopReason: "claude CLI ended the message without a stop reason",
	nativeToolCall: "claude CLI emitted an unsupported native tool call",
	malformedOutput: "claude CLI emitted malformed stream output",
	callMismatch: "claude CLI compatibility error: MCP call does not match its streamed tool intent",
	refusedBeforeAdmission: "claude CLI refused a harness tool call before MCP admission",
	movedOnWhileWaiting: "claude CLI moved on while harness tool calls were waiting for results",
	movedOnWithoutAdmitting: "claude CLI moved on without admitting its harness tool calls",
	invalidToolBatch: "claude CLI emitted an invalid tool batch",
	cliNotFound: ClaudeCodeError.CliNotFound,
};

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
		// Keep native user auth/routing, but override its instruction channels.
		// Settings env can replace inherited env, so pin the memory switch here too.
		"--setting-sources",
		"user",
		"--settings",
		JSON.stringify({ disableAllHooks: true, outputStyle: "default", env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } }),
		"--disable-slash-commands",
		"--no-session-persistence",
		"--permission-prompts",
		"none",
		...(input.allowedTools.length > 0 ? ["--allowedTools", input.allowedTools.join(",")] : []),
	];
}

function toClaudeEnv(): NodeJS.ProcessEnv {
	// Preserve native CLI auth/routing, including launch-environment credentials.
	// Claude Code chooses the account and billing method, not LearnHarness.
	// Loading user settings also loads ~/.claude/CLAUDE.md and memory files;
	// the tutor's system prompt must not inherit them.
	return {
		...externalCliEnv(),
		MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
		CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
		CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	};
}

function classifyToolUse(name: string, harnessToolNames: ReadonlySet<string>): ToolUseVerdict {
	if (name.startsWith(`mcp__${BRIDGE_SERVER_NAME}__`)) return { kind: ToolUseKind.HARNESS, name: toolNameFromMcp(name) };
	// Models sometimes call a harness tool by its bare name. With --tools "" the CLI has no such
	// tool, answers it with an error result and the model retries under the MCP name.
	if (harnessToolNames.has(name)) return { kind: ToolUseKind.RETRY_BARE };
	return { kind: ToolUseKind.NATIVE };
}

/** stream-json stdin: the context window probe first, then the user line. */
function openSession(io: SessionIo, userLine: string, bridge: ToolBridge): CliSession {
	const probe = new ContextWindowProbe(
		(line) => io.write(line),
		() => { if (!io.stopping()) io.write(userLine); },
		(tokens) => io.onContextWindow(tokens),
	);
	return {
		channel: {
			pending: () => bridge.getPendingToolCalls(),
			resolve: (call, result) => bridge.resolveToolCall(call, result),
		},
		begin: () => probe.start(),
		readLine: (line) => {
			if (probe.handle(JSON.parse(line))) return [];
			const event = parseCliLine(line);
			return event ? [event] : [];
		},
		onMessageStart: () => probe.refresh(),
		close: () => probe.close(),
	};
}

async function launch({ model, context, options, hooks }: LaunchInput): Promise<CliLaunch> {
	// The CLI keeps no session: a fresh process replays the whole transcript.
	const input = toClaudeInput(context.messages);
	const bridge = await createToolBridge(input.tools, hooks);
	let dirs: TurnDirs<typeof SYSTEM_PROMPT_FILE | typeof MCP_CONFIG_FILE>;
	try {
		dirs = await createTurnDirs(TURN_DIR_PREFIX, { [SYSTEM_PROMPT_FILE]: input.systemPrompt, [MCP_CONFIG_FILE]: bridge.mcpConfig }, PRIVATE_FILE_MODE);
	} catch (error) {
		await bridge.close();
		throw error;
	}

	return {
		args: toClaudeArgs({
			model: model.id,
			effort: toEffort(options?.reasoning),
			systemPromptFile: dirs.files[SYSTEM_PROMPT_FILE],
			mcpConfigFile: dirs.files[MCP_CONFIG_FILE],
			allowedTools: bridge.allowedTools,
		}),
		cwd: dirs.cwd,
		open: (io) => openSession(io, toStreamJsonLine(input.userContent), bridge),
		dispose: async () => { await Promise.all([bridge.close(), removeTurnDirs(dirs)]); },
	};
}

const claudeAdapter: CliAdapter = {
	ownerName: "claude-code stream owner",
	texts: CLAUDE_TEXTS,
	stopReasons: STOP_REASONS,
	matcher: matchById,
	env: toClaudeEnv,
	reuseEffort: (options: SimpleStreamOptions | undefined) => toEffort(options?.reasoning),
	classifyToolUse,
	assistantErrorMessage: (error, text) => error === NOT_SIGNED_IN_ERROR ? ClaudeCodeError.NotSignedIn : text || error,
	startErrorMessage: (error) => error instanceof ClaudeLaunchError ? error.message : CLAUDE_TEXTS.startFailed,
	launch,
};

export function createClaudeCodeStreamFunction(runClaude: RunClaude): StreamFunction<Api, SimpleStreamOptions> {
	return createCliStreamFunction(claudeAdapter, runClaude);
}

export const streamClaudeCode = createClaudeCodeStreamFunction(createClaudeLauncher());

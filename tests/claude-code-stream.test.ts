/**
 * Claude Code stream function (src/agent/claude-code/stream.ts) and CLI line
 * parser (src/agent/claude-code/cli-events.ts).
 *
 * The runClaude seam spawns tests/fixtures/claude-code/fake-claude.mjs, which
 * replays recorded or synthetic stream-json lines, so the real process
 * plumbing (argv, stdin, stdout lines, stderr, exit, kill) runs end to end.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	JsonObject,
	Message,
	SimpleStreamOptions,
	StreamFunction,
	Api,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { parseCliLine } from "../src/agent/claude-code/cli-events.ts";
import { ClaudeCodeError } from "../src/agent/claude-code/constants.ts";
import { LIVE_PROCESS_IDLE_TIMEOUT_MS, liveProcessIdleTimeoutMs } from "../src/agent/claude-code/live-processes.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { authEnvRecord } from "../src/core/auth-env.ts";
import { ClaudeLaunchError } from "../src/agent/claude-code/launch.ts";
import { createClaudeCodeStreamFunction, toClaudeArgs, toEffort, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { toStreamJsonLine } from "../src/agent/claude-code/transcript.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/claude-code/", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const REPLY = JSON.stringify({ fake: "reply" });
const CLEANUP_TIMEOUT_MS = 2000;

const SESSION_ID = "stream-test-chat";
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };

type ToolUse = { id: string; name: string; arguments: JsonObject };

type RunCall = {
	args: string[];
	cwd: string;
	cwdEntries: string[];
	env: NodeJS.ProcessEnv;
	systemPrompt: string;
	mcpConfig: string;
	mcpConfigMode: number;
	child: ChildProcessWithoutNullStreams;
};

type ScenarioRun = { events: AssistantMessageEvent[]; calls: RunCall[] };

function readFixtureLines(name: string): string[] {
	return readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
}

function getFlagValue(args: string[], flag: string): string {
	const value = args[args.indexOf(flag) + 1];
	assert.ok(args.includes(flag) && value !== undefined, `missing ${flag}`);

	return value;
}

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function exitWith(code: number, stderr: string): string {
	return JSON.stringify({ fake: "exit", code, stderr });
}

function getToolScenario(): string[] {
	const lines = readFixtureLines("tool.jsonl");
	const firstMessageStop = lines.findIndex((line) => line.includes('"type":"message_stop"'));
	return [...lines.slice(0, firstMessageStop + 1).filter((line) => !line.startsWith('{"type":"user"')),
		callTool({ id: "toolu_01JBB4cJsPa585FWb1XrfbNX", name: "get_weather", arguments: { city: "Paris" } }), HOLD];
}

function createFakeRun(
	t: TestContext,
	scenario: string[],
	extraEnv: Record<string, string> = {},
): { runClaude: RunClaude; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const calls: RunCall[] = [];

	const runClaude: RunClaude = (args, options) => {
		const mcpConfigFile = getFlagValue(args, "--mcp-config");
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile, ...extraEnv },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		calls.push({
			args,
			cwd: options.cwd,
			cwdEntries: readdirSync(options.cwd),
			env: options.env,
			systemPrompt: readFileSync(getFlagValue(args, "--system-prompt-file"), "utf8"),
			mcpConfig: readFileSync(mcpConfigFile, "utf8"),
			mcpConfigMode: statSync(mcpConfigFile).mode & 0o777,
			child,
		});
		return child;
	};

	return { runClaude, calls };
}

async function collectEvents(
	stream: AssistantMessageEventStream,
	onEvent: (event: AssistantMessageEvent) => void = () => {},
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];

	for await (const event of stream) {
		events.push(event);
		onEvent(event);
	}

	return events;
}

async function runScenario(
	t: TestContext,
	scenario: string[],
	options?: SimpleStreamOptions,
	extraEnv?: Record<string, string>,
): Promise<ScenarioRun> {
	const { runClaude, calls } = createFakeRun(t, scenario, extraEnv);

	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);

	const context = normalizeContext({
		systemPrompt: "You are a tutor.",
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		tools: [READ_TOOL, { name: "get_weather", description: "Weather", parameters: { type: "object", properties: {} } }],
	});
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(model, context, { sessionId: SESSION_ID, ...options }));

	return { events, calls };
}

function toToolUseMessage(toolUses: ToolUse[], bareIds?: ReadonlySet<string>): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		...toolUses.flatMap((toolUse, index) => [
			streamEvent({
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: toolUse.id, name: bareIds?.has(toolUse.id) ? toolUse.name : `mcp__learnharness__${toolUse.name}`, input: {} },
			}),
			streamEvent({
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.arguments) },
			}),
			streamEvent({ type: "content_block_stop", index }),
		]),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];
}

function callTool(toolUse: ToolUse): string {
	return JSON.stringify({ fake: "call", id: toolUse.id, name: toolUse.name, arguments: toolUse.arguments });
}

function toToolResult(toolUse: ToolUse, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolUse.id,
		toolName: toolUse.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function getModel() {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	return model;
}

async function runTurn(
	streamFunction: StreamFunction<Api, SimpleStreamOptions>,
	messages: Message[],
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });

	const done = getLastEvent(await collectEvents(streamFunction(getModel(), context, { sessionId: SESSION_ID, ...options })));

	assert.ok(done.type === "done", `turn ended with ${done.type}`);

	return done.message;
}

function getText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function getMcpUrl(call: RunCall): string {
	const mcpConfig = JSON.parse(call.mcpConfig) as { mcpServers: Record<string, { url: string }> };
	const url = mcpConfig.mcpServers.learnharness?.url;
	assert.ok(url);
	return url;
}

function getOnlyCall(calls: RunCall[]): RunCall {
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.ok(call);
	return call;
}

function getLastEvent(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const event = events.at(-1);
	assert.ok(event);
	return event;
}

function getErrorMessage(events: AssistantMessageEvent[]): string | undefined {
	const event = getLastEvent(events);
	assert.equal(event.type, "error");
	return event.type === "error" ? event.error.errorMessage : undefined;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;

	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }), "claude CLI process was not killed");
}

async function waitForRemoval(path: string): Promise<void> {
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;

	while (existsSync(path)) {
		assert.ok(Date.now() < deadline, `${path} was not removed`);
		await sleep(10);
	}
}

async function assertCleanedUp(call: RunCall): Promise<void> {
	await waitForExit(call.child);
	await waitForRemoval(call.cwd);
	await waitForRemoval(dirname(getFlagValue(call.args, "--system-prompt-file")));
}

test("toClaudeArgs includes every isolation flag from Global Constraints", () => {
	const input = {
		model: "opus",
		effort: "high",
		systemPromptFile: "/private/system-prompt.md",
		mcpConfigFile: "/private/mcp.json",
		allowedTools: ["mcp__learnharness__read", "mcp__learnharness__write"],
	} as const;

	assert.deepEqual(toClaudeArgs({ ...input, allowedTools: [...input.allowedTools] }), [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		"opus",
		"--effort",
		"high",
		"--system-prompt-file",
		"/private/system-prompt.md",
		"--tools",
		"",
		"--strict-mcp-config",
		"--mcp-config",
		"/private/mcp.json",
		"--setting-sources",
		"user",
		"--settings",
		'{"disableAllHooks":true}',
		"--disable-slash-commands",
		"--no-session-persistence",
		"--permission-prompts",
		"none",
		"--allowedTools",
		"mcp__learnharness__read,mcp__learnharness__write",
	]);

	assert.equal(toClaudeArgs({ ...input, allowedTools: [] }).includes("--allowedTools"), false);
});

test('toEffort maps low..max verbatim, minimal to "low", undefined to "medium"', () => {
	assert.deepEqual(
		(["low", "medium", "high", "xhigh", "max"] as const).map((level) => toEffort(level)),
		["low", "medium", "high", "xhigh", "max"],
	);

	assert.equal(toEffort("minimal"), "low");
	assert.equal(toEffort(undefined), "medium");
});

test("text scenario streams start, text_start, text_delta…, text_end, done(stop)", async (t) => {
	const { events, calls } = await runScenario(t, readFixtureLines("text.jsonl"));

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_start", "text_delta", "text_end", "done"],
	);

	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.equal(done.reason, "stop");
	assert.equal(done.message.stopReason, "stop");
	assert.deepEqual(done.message.content, [{ type: "text", text: "hello there" }]);
	assert.equal(done.message.provider, "claude-code");
	assert.equal(done.message.api, "claude-code-cli");
	assert.equal(done.message.model, "opus");

	await assertCleanedUp(getOnlyCall(calls));
});

test("thinking deltas map to thinking_*", async (t) => {
	const { events } = await runScenario(t, [
		streamEvent({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Sockets are " } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "endpoints." } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "An endpoint." } }),
		streamEvent({ type: "content_block_stop", index: 1 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
		streamEvent({ type: "message_stop" }),
	]);

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"],
	);

	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.deepEqual(done.message.content, [
		{ type: "thinking", thinking: "Sockets are endpoints." },
		{ type: "text", text: "An endpoint." },
	]);
});

test("tool scenario ends with toolcall_end (Claude's tool_use id, unprefixed name) and done(toolUse)", async (t) => {
	const { events } = await runScenario(t, getToolScenario());

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "toolcall_start", "toolcall_end", "done"],
	);

	const toolCallEnd = events.find((event) => event.type === "toolcall_end");
	assert.ok(toolCallEnd?.type === "toolcall_end");
	assert.deepEqual(toolCallEnd.toolCall, {
		type: "toolCall",
		id: "toolu_01JBB4cJsPa585FWb1XrfbNX",
		name: "get_weather",
		arguments: { city: "Paris" },
	});

	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(done.message.content, [toolCallEnd.toolCall]);
});

test("unsupported native tool intent fails without exposing executable calls", async (t) => {
	const { events } = await runScenario(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_a", name: "mcp__learnharness__nope", input: {} },
		}),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": ' } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_b", name: "Bash", input: {} } }),
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
		streamEvent({ type: "content_block_stop", index: 1 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		HOLD,
	]);

	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	assert.match(getErrorMessage(events) ?? "", /unsupported native tool/);
});

function bareToolUse(index: number, toolUse: ToolUse): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input: {} } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.arguments) } }),
		streamEvent({ type: "content_block_stop", index }),
	];
}

function rejectBareCall(toolUse: ToolUse): string {
	const content = `<tool_use_error>Error: No such tool available: ${toolUse.name}</tool_use_error>`;
	return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content }] } });
}

test("a harness tool called by its bare name is left to the CLI, and the prefixed retry is admitted", async (t) => {
	const bare: ToolUse = { id: "toolu_bare_only", name: "read", arguments: { path: "a" } };
	const retry: ToolUse = { id: "toolu_bare_retry", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		...bareToolUse(0, bare),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		rejectBareCall(bare),
		...toToolUseMessage([retry]),
		callTool(retry),
		REPLY,
	]);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	assert.deepEqual(toolMessage.content, [{ type: "toolCall", id: retry.id, name: "read", arguments: { path: "a" } }]);
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(retry, "contents of a")]);
	assert.equal(getText(reply), "contents of a");
	await assertCleanedUp(getOnlyCall(calls));
});

test("a bare harness call beside a prefixed one admits only the prefixed call", async (t) => {
	const bare: ToolUse = { id: "toolu_bare_mixed", name: "read", arguments: { path: "b" } };
	const prefixed: ToolUse = { id: "toolu_prefixed_mixed", name: "read", arguments: { path: "a" } };
	const prefixedMessage = toToolUseMessage([prefixed]);
	const { runClaude, calls } = createFakeRun(t, [
		...prefixedMessage.slice(0, -2),
		...bareToolUse(1, bare),
		...prefixedMessage.slice(-2),
		rejectBareCall(bare),
		callTool(prefixed),
		REPLY,
	]);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	assert.deepEqual(toolMessage.content, [{ type: "toolCall", id: prefixed.id, name: "read", arguments: { path: "a" } }]);
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(prefixed, "contents of a")]);
	assert.equal(getText(reply), "contents of a");
	await assertCleanedUp(getOnlyCall(calls));
});

function toBareToolUseMessage(toolUses: ToolUse[]): string[] {
	return toToolUseMessage(toolUses, new Set(toolUses.map((call) => call.id)));
}

test("repeated bare-only messages admit only the eventual MCP correction and reuse the process", async (t) => {
	const first: ToolUse = { id: "toolu_bare_first", name: "read", arguments: { path: "a" } };
	const second: ToolUse = { ...first, id: "toolu_bare_second" };
	const retry: ToolUse = { ...first, id: "toolu_corrected" };
	const { runClaude, calls } = createFakeRun(t, [
		...toBareToolUseMessage([first]), rejectBareCall(first),
		...toBareToolUseMessage([second]), rejectBareCall(second),
		...toToolUseMessage([retry]), callTool(retry), REPLY,
	]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const message = await runTurn(stream, [HI]);
	assert.deepEqual(message.content, [{ type: "toolCall", ...retry }]);
	const reply = await runTurn(stream, [HI, message, toToolResult(retry, "contents of a")]);
	assert.equal(getText(reply), "contents of a");
	await assertCleanedUp(getOnlyCall(calls));
});

test("a bare call before a prefixed sibling cannot become executable or corrupt its arguments", async (t) => {
	const bare: ToolUse = { id: "toolu_bare_before", name: "read", arguments: { path: "not admitted" } };
	const prefixed: ToolUse = { id: "toolu_prefixed_after", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [
		...toToolUseMessage([bare, prefixed], new Set([bare.id])),
		rejectBareCall(bare), callTool(prefixed), REPLY,
	]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const message = await runTurn(stream, [HI]);
	assert.deepEqual(message.content, [{ type: "toolCall", ...prefixed }]);
	const reply = await runTurn(stream, [HI, message, toToolResult(prefixed, "contents of a")]);
	assert.equal(getText(reply), "contents of a");
	await assertCleanedUp(getOnlyCall(calls));
});

for (const name of ["recall", "send_to_user"]) test(`a declared ${name} can recover from a bare name without exposing the rejected call`, async (t) => {
	const bare: ToolUse = { id: `toolu_bare_${name}`, name, arguments: {} };
	const retry: ToolUse = { ...bare, id: `toolu_corrected_${name}` };
	const { runClaude, calls } = createFakeRun(t, [
		...toBareToolUseMessage([bare]), rejectBareCall(bare),
		...toToolUseMessage([retry]), callTool(retry), HOLD,
	]);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const context = normalizeContext({ messages: [HI], tools: [{ name, description: "Test harness tool", parameters: Type.Object({}) }] });
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), context, { sessionId: SESSION_ID, signal: controller.signal }));
	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.deepEqual(done.message.content, [{ type: "toolCall", ...retry }]);
	assert.deepEqual(events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id), [retry.id]);
	controller.abort();
	await assertCleanedUp(getOnlyCall(calls));
});

test("a bare-only rejection may finish with ordinary text instead of an MCP retry", async (t) => {
	const bare: ToolUse = { id: "toolu_bare_then_text", name: "read", arguments: {} };
	const { events, calls } = await runScenario(t, [
		...toBareToolUseMessage([bare]), rejectBareCall(bare), ...readFixtureLines("text.jsonl"), HOLD,
	]);
	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.equal(done.reason, "stop");
	assert.equal(getText(done.message), "hello there");
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	await assertCleanedUp(getOnlyCall(calls));
});

{
	const bare: ToolUse = { id: "toolu_bare_before_failure", name: "read", arguments: { path: "a" } };
	const retry: ToolUse = { ...bare, id: "toolu_retry_before_failure" };
	const failures = [
		{ name: "an unknown native Bash call", lines: toBareToolUseMessage([{ ...retry, name: "Bash" }]), error: /unsupported native tool/ },
		{ name: "a bare tool absent from the current declarations", lines: toBareToolUseMessage([{ ...retry, name: "send_to_user" }]), error: /unsupported native tool/ },
		{ name: "an empty tool-use batch in the next message", lines: toToolUseMessage([]), error: /invalid tool batch/ },
		{ name: "duplicate corrected intent IDs", lines: toToolUseMessage([retry, retry]), error: /invalid tool batch/ },
		{ name: "a prefixed retry with no MCP request", lines: [...toToolUseMessage([retry]), exitWith(1, "")], error: /exited with code 1/ },
		{ name: "a prefixed retry rejected before MCP admission", lines: [...toToolUseMessage([retry]), rejectBareCall(retry)], error: /refused.*before MCP admission/ },
		{ name: "missing MCP identity", lines: [...toToolUseMessage([retry]), JSON.stringify({ fake: "call", name: retry.name, arguments: retry.arguments })], error: /compatibility error.*claudecode\/toolUseId/ },
		{ name: "mismatched MCP identity", lines: [...toToolUseMessage([retry]), callTool({ ...retry, id: "toolu_not_the_retry" })], error: /does not match its streamed tool intent/ },
		{ name: "mismatched MCP arguments", lines: [...toToolUseMessage([retry]), callTool({ ...retry, arguments: { path: "different" } })], error: /does not match its streamed tool intent/ },
		{ name: "a terminal CLI error", lines: [JSON.stringify({ type: "result", is_error: true, result: "Synthetic CLI failure" })], error: /Synthetic CLI failure/ },
		{ name: "CLI exit before correction", lines: [exitWith(1, "")], error: /exited with code 1/ },
	];
	for (const failure of failures) test(`bare-call tolerance still rejects ${failure.name}`, async (t) => {
		const { events, calls } = await runScenario(t, [
			...toBareToolUseMessage([bare]), rejectBareCall(bare), ...failure.lines, HOLD,
		]);
		assert.match(getErrorMessage(events) ?? "", failure.error);
		assert.equal(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);
		await assertCleanedUp(getOnlyCall(calls));
	});
}

test("a bare name from a removed tool is not tolerated when no tools are declared", async (t) => {
	const bare: ToolUse = { id: "toolu_removed_read", name: "read", arguments: {} };
	const { runClaude, calls } = createFakeRun(t, [...toBareToolUseMessage([bare]), HOLD]);
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), normalizeContext({ messages: [HI], tools: [] })));
	assert.match(getErrorMessage(events) ?? "", /unsupported native tool/);
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	await assertCleanedUp(getOnlyCall(calls));
});

test("cancellation after a bare-only rejection aborts the wait and cleans up the process", async (t) => {
	const bare: ToolUse = { id: "toolu_bare_cancelled", name: "read", arguments: {} };
	const fake = createFakeRun(t, [
		...toBareToolUseMessage([bare]), rejectBareCall(bare), JSON.stringify({ fake: "checkpoint" }), HOLD,
	]);
	const controller = new AbortController();
	t.after(() => controller.abort());
	let checkpointSeen = false;
	const runClaude: RunClaude = async (args, options) => {
		const child = await fake.runClaude(args, options);
		assert.ok(child);
		child.once("message", () => { checkpointSeen = true; controller.abort(); });
		return child;
	};
	const context = normalizeContext({ messages: [HI], tools: [READ_TOOL] });
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), context, { signal: controller.signal }));
	const error = getLastEvent(events);
	assert.ok(error.type === "error");
	assert.equal(error.reason, "aborted");
	assert.equal(checkpointSeen, true);
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	await assertCleanedUp(getOnlyCall(fake.calls));
});

test("usage maps input/output/cacheRead/cacheWrite with zero cost, message_delta overriding message_start", async (t) => {
	const { events } = await runScenario(t, getToolScenario());
	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.deepEqual(done.message.usage, {
		input: 2,
		output: 59,
		cacheRead: 0,
		cacheWrite: 1102,
		totalTokens: 1163,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test('missing binary → error "claude CLI not found"', async () => {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);

	let cwd = "";
	const runClaude: RunClaude = (_args, options) => {
		cwd = options.cwd;
		return null;
	};

	const context = normalizeContext({ systemPrompt: "p", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(model, context));

	assert.deepEqual(
		events.map((event) => event.type),
		["error"],
	);

	assert.equal(getErrorMessage(events), ClaudeCodeError.CliNotFound);
	await waitForRemoval(cwd);
});

test('signed-out fixture → error "not signed in"', async (t) => {
	const { events, calls } = await runScenario(t, [...readFixtureLines("signed-out.jsonl"), exitWith(1, "")]);
	assert.equal(getErrorMessage(events), ClaudeCodeError.NotSignedIn);
	await assertCleanedUp(getOnlyCall(calls));
});

test("other assistant errors surface their text", async (t) => {
	const assistantError = JSON.stringify({
		type: "assistant",
		error: "rate_limit",
		message: { content: [{ type: "text", text: "API Error: Rate limit reached" }] },
	});
	const { events } = await runScenario(t, [assistantError, exitWith(1, "")]);
	assert.equal(getErrorMessage(events), "API Error: Rate limit reached");
});

test("result error before message_stop surfaces the result text", async (t) => {
	const resultError = JSON.stringify({
		type: "result",
		subtype: "error_during_execution",
		is_error: true,
		result: "Credit balance is too low",
	});
	const { events } = await runScenario(t, [resultError, HOLD]);
	assert.equal(getErrorMessage(events), "Credit balance is too low");
});

test("result error without result text surfaces its errors", async (t) => {
	const resultError = JSON.stringify({
		type: "result",
		subtype: "error_max_turns",
		is_error: true,
		errors: ["Reached maximum number of turns"],
	});
	const { events } = await runScenario(t, [resultError, HOLD]);
	assert.equal(getErrorMessage(events), "Reached maximum number of turns");
});

test("result error without result text or errors surfaces its subtype", async (t) => {
	const resultError = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true });
	const { events } = await runScenario(t, [resultError, HOLD]);
	assert.equal(getErrorMessage(events), "claude CLI failed: error_during_execution");
});

test("refusal stop reason → error", async (t) => {
	const { events } = await runScenario(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "refusal" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	]);
	assert.equal(getErrorMessage(events), "The model refused to complete the request");
});

test("non-zero exit mid-stream → error naming the exit code, stderr logged not shown, process and temp dirs gone", async (t) => {
	const consoleError = t.mock.method(console, "error", () => {});
	const midStream = readFixtureLines("text.jsonl").slice(0, 5);
	const { events, calls } = await runScenario(t, [...midStream, exitWith(1, "Error: ENOENT /home/someone/.claude/x\n    at main\n")]);

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_start", "text_delta", "error"],
	);

	assert.equal(getErrorMessage(events), "claude CLI exited with code 1");
	assert.ok(
		consoleError.mock.calls.some((call) => call.arguments.some((argument) => String(argument).includes("ENOENT /home/someone/.claude/x"))),
	);

	const error = getLastEvent(events);
	assert.ok(error.type === "error");
	assert.equal(error.reason, "error");
	assert.deepEqual(error.error.content, [{ type: "text", text: "hello there" }]);

	await assertCleanedUp(getOnlyCall(calls));
});

test("exit without stderr names the exit code", async (t) => {
	const { events } = await runScenario(t, [exitWith(3, "")]);
	assert.equal(getErrorMessage(events), "claude CLI exited with code 3");
});

test("abort kills the process and ends with error(aborted)", async (t) => {
	const { runClaude, calls } = createFakeRun(t, [streamEvent({ type: "message_start", message: { usage: {} } }), HOLD]);
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	const controller = new AbortController();
	const context = normalizeContext({ systemPrompt: "p", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const stream = createClaudeCodeStreamFunction(runClaude)(model, context, { signal: controller.signal });

	const events = await collectEvents(stream, (event) => {
		if (event.type === "start") controller.abort();
	});

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "error"],
	);

	const error = getLastEvent(events);
	assert.ok(error.type === "error");
	assert.equal(error.reason, "aborted");

	await assertCleanedUp(getOnlyCall(calls));
});

test("cwd is an empty temp dir; prompt and mcp config live in a separate private dir", async (t) => {
	const { calls } = await runScenario(t, readFixtureLines("text.jsonl"));
	const call = getOnlyCall(calls);

	assert.deepEqual(call.cwdEntries, []);
	assert.ok(call.cwd.startsWith(tmpdir()));

	const privateDir = dirname(getFlagValue(call.args, "--system-prompt-file"));
	assert.notEqual(privateDir, call.cwd);
	assert.ok(!privateDir.startsWith(call.cwd + sep));
	assert.equal(dirname(getFlagValue(call.args, "--mcp-config")), privateDir);
	assert.equal(call.systemPrompt, "You are a tutor.");
	assert.equal(call.mcpConfigMode, 0o600);

	const mcpConfig = JSON.parse(call.mcpConfig) as { mcpServers: Record<string, { url: string }> };
	assert.match(mcpConfig.mcpServers.learnharness?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
});

test("spawns with the model alias, effort, bridge tools, MCP timeout headroom and the caller's HOME", async (t) => {
	const { calls } = await runScenario(t, readFixtureLines("text.jsonl"), { reasoning: "xhigh" });
	const call = getOnlyCall(calls);
	assert.equal(getFlagValue(call.args, "--model"), "opus");
	assert.equal(getFlagValue(call.args, "--effort"), "xhigh");
	assert.equal(getFlagValue(call.args, "--allowedTools"), "mcp__learnharness__read,mcp__learnharness__get_weather");
	assert.equal(call.env.MCP_TOOL_TIMEOUT, "1800000");
	assert.equal(call.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "1800000");
	assert.equal(LIVE_PROCESS_IDLE_TIMEOUT_MS, 600000, "learner-wait retention stays at ten minutes");
	for (const name of ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"]) {
		assert.ok(Number(call.env[name]) > LIVE_PROCESS_IDLE_TIMEOUT_MS, `${name} must outlast LearnHarness retention`);
	}
	assert.equal(call.env.HOME, process.env.HOME);
	assert.equal(call.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
});

test("MCP timeout headroom overrides inherited shorter timeouts", async (t) => {
	const names = ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] as const;
	const saved = names.map((name) => [name, process.env[name]] as const);
	t.after(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	for (const name of names) process.env[name] = "300000";

	const { calls } = await runScenario(t, readFixtureLines("text.jsonl"));
	const call = getOnlyCall(calls);
	for (const name of names) assert.equal(call.env[name], "1800000");
});

test("preserves existing CLI environment authentication without a subscription guarantee", async (t) => {
	const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	process.env.ANTHROPIC_API_KEY = "sk-ant-test";
	process.env.ANTHROPIC_AUTH_TOKEN = "token-test";

	const { calls } = await runScenario(t, readFixtureLines("text.jsonl"));
	const call = getOnlyCall(calls);

	assert.equal(call.env.ANTHROPIC_API_KEY, "sk-ant-test");
	assert.equal(call.env.ANTHROPIC_AUTH_TOKEN, "token-test");
});

test("does not inject credentials reflected only from LearnHarness's key store", async (t) => {
	const name = "ANTHROPIC_API_KEY";
	const record = authEnvRecord();
	const saved = process.env[name];
	t.after(() => {
		record.fillGap.delete(name);
		if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
	});
	process.env[name] = "lh-only-key";
	record.fillGap.add(name);
	const { calls } = await runScenario(t, readFixtureLines("text.jsonl"));
	assert.equal(getOnlyCall(calls).env[name], undefined);
	assert.equal(process.env[name], "lh-only-key", "other LearnHarness providers keep their env reflection");
});

test("writes one user prompt after local-only control initialization and summary request", async (t) => {
	const stdinFile = join(mkdtempSync(join(tmpdir(), "claude-code-stdin-")), "stdin.jsonl");
	t.after(() => rmSync(dirname(stdinFile), { recursive: true, force: true }));

	await runScenario(t, readFixtureLines("text.jsonl"), undefined, { FAKE_CLAUDE_STDIN: stdinFile });

	const lines = readFileSync(stdinFile, "utf8").trim().split("\n");
	assert(lines.length >= 3);
	assert.deepEqual(JSON.parse(lines[0]!).request, { subtype: "initialize" });
	assert.deepEqual(JSON.parse(lines[1]!).request, { subtype: "get_context_usage", detail: "summary" });
	assert.equal(lines[2], toStreamJsonLine([{ type: "text", text: "hi" }]));
	assert(lines.slice(3).every((line) => JSON.parse(line).request.detail === "summary"));
});

test("parseCliLine ignores non-JSON, system, rate-limit and successful result lines", () => {
	assert.equal(parseCliLine("not json"), null);
	assert.equal(parseCliLine("null"), null);
	assert.equal(parseCliLine('{"type":"system","subtype":"init"}'), null);
	assert.equal(parseCliLine('{"type":"rate_limit_event"}'), null);
	assert.equal(parseCliLine('{"type":"result","is_error":false,"result":"hello there"}'), null);
	assert.equal(parseCliLine('{"type":"assistant","error":null,"message":{"content":[{"type":"text","text":"hello there"}]}}'), null);
});

test("trailing toolResults matching a live process continue it: held calls answered, new assistant message streamed, no new spawn", async (t) => {
	const readA: ToolUse = { id: "toolu_continue_a", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA]), callTool(readA), REPLY]);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(readA, "contents of a")]);

	assert.equal(toolMessage.stopReason, "toolUse");
	assert.equal(getText(reply), "contents of a");
	await assertCleanedUp(getOnlyCall(calls));
});

test("sequential identical calls split one response and correlate results by id, not arguments", async (t) => {
	const readA: ToolUse = { id: "toolu_many_a", name: "read", arguments: { path: "a" } };
	const readB: ToolUse = { id: "toolu_many_b", name: "read", arguments: { path: "a" } };
	const source = toToolUseMessage([readA, readB]);
	source[0] = streamEvent({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 2 } } });
	const { runClaude, calls } = createFakeRun(t, [...source, callTool(readB), callTool(readA), REPLY]);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	assert.deepEqual(toolMessage.content.filter((block) => block.type === "toolCall").map((call) => call.id), [readB.id]);
	const history = [HI, toolMessage, toToolResult(readB, "B")];
	const second = await runTurn(streamFunction, history);
	assert.deepEqual(second.content.filter((block) => block.type === "toolCall").map((call) => call.id), [readA.id]);
	const reply = await runTurn(streamFunction, [...history, second, toToolResult(readA, "A")]);

	assert.equal(getText(reply), "B | A");
	assert.equal(toolMessage.usage.totalTokens, 9);
	assert.equal(second.usage.totalTokens, 0, "splitting one response must not charge its tokens twice");
	assert.equal(calls.length, 1);
});

test("mismatched result id starts fresh and kills the old process", async (t) => {
	const readA: ToolUse = { id: "toolu_partial_a", name: "read", arguments: { path: "a" } };
	const readB: ToolUse = { id: "toolu_partial_b", name: "read", arguments: { path: "b" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA, readB]), callTool(readA), callTool(readB), REPLY]);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	await runTurn(streamFunction, [HI, toolMessage, toToolResult(readB, "B")]);

	assert.equal(calls.length, 2);
	const [oldCall] = calls;
	assert.ok(oldCall);
	await assertCleanedUp(oldCall);
});

test("user message after tool results starts fresh with unfinished calls in the replay", async (t) => {
	const stdinFile = join(mkdtempSync(join(tmpdir(), "claude-code-stdin-")), "stdin.jsonl");
	t.after(() => rmSync(dirname(stdinFile), { recursive: true, force: true }));

	const readA: ToolUse = { id: "toolu_steer_a", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA]), callTool(readA), REPLY], { FAKE_CLAUDE_STDIN: stdinFile });
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);
	const steer: Message = { role: "user", content: "wait, explain sockets first", timestamp: 0 };

	await runTurn(streamFunction, [HI, toolMessage, toToolResult(readA, "A"), steer]);

	assert.equal(calls.length, 2);

	const [oldCall] = calls;
	assert.ok(oldCall);
	await assertCleanedUp(oldCall);

	const stdin = readFileSync(stdinFile, "utf8");
	assert.ok(stdin.includes('[tool call read] {\\"path\\":\\"a\\"}'), stdin);
	assert.ok(stdin.includes("wait, explain sockets first"), stdin);
});

test("output while waiting for tool results kills the process", async (t) => {
	const readA: ToolUse = { id: "toolu_moved_on_a", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA]), REPLY, HOLD]);
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] })));
	assert.match(getErrorMessage(events) ?? "", /moved on without admitting/);
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	await assertCleanedUp(getOnlyCall(calls));
});

test("unadmitted tool intent never becomes an executable call", async (t) => {
	const readA: ToolUse = { id: "toolu_undeclared_a", name: "read", arguments: { path: "a" } };
	const nope: ToolUse = { id: "toolu_undeclared_nope", name: "nope", arguments: {} };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA, nope]), exitWith(1, "tool denied")]);
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] })));
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	assert.match(getErrorMessage(events) ?? "", /exited with code 1/);
	await assertCleanedUp(getOnlyCall(calls));
});

test("a CLI-rejected malformed call is not exposed for execution", async (t) => {
	const { runClaude, calls } = createFakeRun(t, [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_bad_json", name: "mcp__learnharness__read", input: {} },
		}),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": ' } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bad_json", is_error: true, content: "invalid arguments" }] } }),
		HOLD,
	]);

	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] })));
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	assert.match(getErrorMessage(events) ?? "", /refused.*before MCP admission/);
	await assertCleanedUp(getOnlyCall(calls));
});

test("abort while waiting kills the process and closes the bridge", async (t) => {
	const readA: ToolUse = { id: "toolu_abort_a", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA]), callTool(readA), REPLY]);
	const controller = new AbortController();

	await runTurn(createClaudeCodeStreamFunction(runClaude), [HI], { signal: controller.signal });

	controller.abort();

	const call = getOnlyCall(calls);
	await assertCleanedUp(call);
	await assert.rejects(fetch(getMcpUrl(call)));
});

test("idle timeout kills an orphaned waiting process", async (t) => {
	liveProcessIdleTimeoutMs.current = 50;
	t.after(() => (liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS));

	const readA: ToolUse = { id: "toolu_idle_a", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA]), callTool(readA), REPLY]);

	await runTurn(createClaudeCodeStreamFunction(runClaude), [HI]);

	await assertCleanedUp(getOnlyCall(calls));
});

test("a tool result arriving after the idle timeout starts fresh with the call and its result in the replay", async (t) => {
	liveProcessIdleTimeoutMs.current = 300;
	t.after(() => (liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS));

	const stdinFile = join(mkdtempSync(join(tmpdir(), "claude-code-stdin-")), "stdin.jsonl");
	t.after(() => rmSync(dirname(stdinFile), { recursive: true, force: true }));

	const readA: ToolUse = { id: "toolu_late_a", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([readA]), callTool(readA), REPLY]);
	const fresh = createFakeRun(t, readFixtureLines("text.jsonl"), { FAKE_CLAUDE_STDIN: stdinFile });
	const runClaude: RunClaude = (args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	const waitingCall = getOnlyCall(waiting.calls);
	assert.equal(waitingCall.child.exitCode, null, "the process should wait for the tool result until the idle timeout");
	await assertCleanedUp(waitingCall);

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(readA, "contents of a")]);

	assert.equal(getText(reply), "hello there");
	await assertCleanedUp(getOnlyCall(fresh.calls));

	const stdin = readFileSync(stdinFile, "utf8");
	assert.ok(stdin.includes('[tool call read] {\\"path\\":\\"a\\"}'), stdin);
	assert.ok(stdin.includes("[tool result read]"), stdin);
	assert.ok(stdin.includes("contents of a"), stdin);
});

test("a tool result arriving late but before the idle timeout still continues the waiting process", async (t) => {
	liveProcessIdleTimeoutMs.current = 1000;
	t.after(() => (liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS));

	const readA: ToolUse = { id: "toolu_slow_a", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([readA]), callTool(readA), REPLY]);
	const streamFunction = createClaudeCodeStreamFunction(runClaude);
	const toolMessage = await runTurn(streamFunction, [HI]);

	await sleep(500);

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(readA, "contents of a")]);

	assert.equal(getText(reply), "contents of a");
	await assertCleanedUp(getOnlyCall(calls));
});

test("CLI denial cannot execute a tool in the native Pi loop", async (t) => {
	const read: ToolUse = { id: "toolu_denied", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([read]), JSON.stringify({ type: "user", message: { content: [
		{ type: "tool_result", tool_use_id: read.id, is_error: true, content: "Denied by managed policy" },
	] } }), HOLD]);
	let executed = 0;
	const agent = new Agent({ initialState: { model: getModel(), tools: [{
		name: "read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }),
		execute: async () => { executed++; return { content: [{ type: "text", text: "must not run" }], details: null }; },
	}] }, streamFn: createClaudeCodeStreamFunction(runClaude) });
	await agent.prompt("hi");
	assert.equal(executed, 0);
	const last = agent.state.messages.at(-1);
	assert.ok(last?.role === "assistant");
	assert.equal(last.stopReason, "error");
	assert.match(last.errorMessage ?? "", /refused.*before MCP admission/);
	await assertCleanedUp(getOnlyCall(calls));
});

test("pre-aborted requests do not spawn a process", async () => {
	const controller = new AbortController();
	controller.abort();
	let spawned = false;
	const stream = createClaudeCodeStreamFunction(() => { spawned = true; return null; });
	const events = await collectEvents(stream(getModel(), normalizeContext({ messages: [HI] }), { signal: controller.signal }));
	assert.equal(spawned, false);
	assert.match(getErrorMessage(events) ?? "", /aborted/);
});

test("missing MCP identity fails closed without emitting executable calls", async (t) => {
	const read: ToolUse = { id: "toolu_no_meta", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([read]), JSON.stringify({ fake: "call", name: read.name, arguments: read.arguments })]);
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] })));
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	assert.match(getErrorMessage(events) ?? "", /compatibility error.*claudecode\/toolUseId/);
	await assertCleanedUp(getOnlyCall(calls));
});

test("a parallel identity failure after an admitted slice is reported on continuation, not hidden by replay", async (t) => {
	const first: ToolUse = { id: "toolu_good_parallel", name: "read", arguments: { path: "a" } };
	const second: ToolUse = { id: "toolu_bad_parallel", name: "read", arguments: { path: "b" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([first, second]),
		JSON.stringify({ fake: "start-call", id: first.id, name: first.name, arguments: first.arguments }),
		JSON.stringify({ fake: "wait-for-message" }),
		JSON.stringify({ fake: "call", name: second.name, arguments: second.arguments }), HOLD]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const message = await runTurn(stream, [HI]);
	getOnlyCall(calls).child.send("continue");
	await waitForExit(getOnlyCall(calls).child);
	const events = await collectEvents(stream(getModel(), normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI, message, toToolResult(first, "A")], tools: [READ_TOOL] }), { sessionId: SESSION_ID }));
	assert.match(getErrorMessage(events) ?? "", /compatibility error.*claudecode\/toolUseId/);
	assert.equal(calls.length, 1, "must not hide the compatibility failure by spawning again");
	await assertCleanedUp(getOnlyCall(calls));
});

test("output after MCP admission fails continuation instead of silently replaying", async (t) => {
	const call: ToolUse = { id: "toolu_moved_on", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([call]),
		JSON.stringify({ fake: "start-call", id: call.id, name: call.name, arguments: call.arguments }),
		JSON.stringify({ fake: "wait-for-message" }), ...toToolUseMessage([call]), HOLD]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const message = await runTurn(stream, [HI]);
	getOnlyCall(calls).child.send("continue");
	await waitForExit(getOnlyCall(calls).child);
	const events = await collectEvents(stream(getModel(), normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI, message, toToolResult(call, "A")], tools: [READ_TOOL] }), { sessionId: SESSION_ID }));
	assert.match(getErrorMessage(events) ?? "", /moved on while.*waiting for results/);
	assert.equal(calls.length, 1);
	await assertCleanedUp(getOnlyCall(calls));
});

test("normal completion escalates termination when the child ignores SIGTERM", async (t) => {
	const { events, calls } = await runScenario(t, [JSON.stringify({ fake: "ignore-term" }), ...readFixtureLines("text.jsonl"), HOLD]);
	assert.equal(getLastEvent(events).type, "done");
	await assertCleanedUp(getOnlyCall(calls));
	assert.equal(getOnlyCall(calls).child.signalCode, "SIGKILL");
});

for (const asyncVersionFailure of [false, true]) test(`${asyncVersionFailure ? "an asynchronous version-check" : "a synchronous spawn"} failure removes both temp directories and the bridge`, async () => {
	let resources: { cwd: string; privateDir: string; url: string } | undefined;
	const stream = createClaudeCodeStreamFunction((args, options) => {
		const config = JSON.parse(readFileSync(getFlagValue(args, "--mcp-config"), "utf8"));
		resources = { cwd: options.cwd, privateDir: dirname(getFlagValue(args, "--mcp-config")), url: config.mcpServers.learnharness.url };
		if (asyncVersionFailure) return Promise.reject(new ClaudeLaunchError("Claude Code requires an update"));
		throw new Error("synthetic spawn failure");
	});
	const events = await collectEvents(stream(getModel(), normalizeContext({ messages: [HI] })));
	assert.match(getErrorMessage(events) ?? "", asyncVersionFailure ? /requires an update/ : /failed to start/);
	assert.ok(resources);
	assert.equal(existsSync(resources.cwd), false);
	assert.equal(existsSync(resources.privateDir), false);
	await assert.rejects(fetch(resources.url));
});

test("a malformed JSON event shape fails the turn rather than escaping the readline handler", async (t) => {
	const { events, calls } = await runScenario(t, [JSON.stringify({ type: "assistant", error: "bad", message: { content: [null] } }), HOLD]);
	assert.match(getErrorMessage(events) ?? "", /malformed stream output/);
	await assertCleanedUp(getOnlyCall(calls));
});

test("a mismatched MCP identity cannot admit a streamed call", async (t) => {
	const read: ToolUse = { id: "toolu_intent", name: "read", arguments: { path: "a" } };
	const { runClaude, calls } = createFakeRun(t, [...toToolUseMessage([read]), callTool({ ...read, id: "toolu_someone_else" })]);
	const events = await collectEvents(createClaudeCodeStreamFunction(runClaude)(getModel(), normalizeContext({ messages: [HI], tools: [READ_TOOL] })));
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	assert.match(getErrorMessage(events) ?? "", /does not match its streamed tool intent/);
	await assertCleanedUp(getOnlyCall(calls));
});

for (const change of ["model", "effort", "system prompt", "tool schema", "tool description", "history", "authentication environment"] as const) {
	test(`a changed ${change} prevents reuse of a held process`, async (t) => {
		const read: ToolUse = { id: `toolu_reuse_${change}`, name: "read", arguments: { path: "a" } };
		const waiting = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY]);
		const fresh = createFakeRun(t, readFixtureLines("text.jsonl"));
		const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
		const message = await runTurn(stream, [HI]);
		if (change === "authentication environment") {
			const saved = process.env.ANTHROPIC_AUTH_TOKEN;
			t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved; });
			process.env.ANTHROPIC_AUTH_TOKEN = "changed-cli-auth";
		}
		const messages = [change === "history" ? { ...HI, content: "replacement history after compaction" } : HI, message, toToolResult(read, "A")];
		const context = normalizeContext({
			systemPrompt: change === "system prompt" ? "Changed tutor instructions" : "You are a tutor.",
			messages,
			tools: [{ ...READ_TOOL,
				...(change === "tool schema" ? { parameters: { type: "object", properties: { path: { type: "string" } } } } : {}),
				...(change === "tool description" ? { description: "Changed description" } : {}),
			}],
		});
		const model = change === "model" ? CLAUDE_CODE_MODELS[1]! : getModel();
		const events = await collectEvents(stream(model, context, { sessionId: SESSION_ID, ...(change === "effort" ? { reasoning: "high" as const } : {}) }));
		assert.equal(getLastEvent(events).type, "done");
		assert.equal(fresh.calls.length, 1, "must start a fresh CLI rather than silently use stale configuration");
		await assertCleanedUp(getOnlyCall(waiting.calls));
	});
}

for (const identicalHistory of [false, true]) test(`one registered stream isolates two sessions with colliding tool IDs and ${identicalHistory ? "identical" : "different"} histories`, async (t) => {
	const call: ToolUse = { id: "toolu_shared_singleton", name: "read", arguments: { path: "same" } };
	const one = createFakeRun(t, [...toToolUseMessage([call]), callTool(call), REPLY]);
	const two = createFakeRun(t, [...toToolUseMessage([call]), callTool(call), REPLY]);
	let spawns = 0;
	const stream = createClaudeCodeStreamFunction((args, options) => {
		const run = [one, two][spawns++];
		assert.ok(run, "a valid continuation must not spawn another CLI");
		return run.runClaude(args, options);
	});
	const historyOne = [HI];
	const historyTwo: Message[] = identicalHistory ? [HI] : [{ role: "user", content: "another conversation", timestamp: 0 }];
	const messageOne = await runTurn(stream, historyOne, { sessionId: "chat-one" });
	const messageTwo = await runTurn(stream, historyTwo, { sessionId: "chat-two" });
	// B returns first while A is earlier in the registry: IDs and even full
	// history must not let B resolve A's authenticated MCP request.
	const replyTwo = await runTurn(stream, [...historyTwo, messageTwo, toToolResult(call, "from two")], { sessionId: "chat-two" });
	const replyOne = await runTurn(stream, [...historyOne, messageOne, toToolResult(call, "from one")], { sessionId: "chat-one" });
	assert.equal(getText(replyTwo), "from two");
	assert.equal(getText(replyOne), "from one");
	assert.equal(spawns, 2);
	await assertCleanedUp(getOnlyCall(one.calls));
	await assertCleanedUp(getOnlyCall(two.calls));
});

test("a caller without a session ID uses fresh replay and retains no held process", async (t) => {
	const call: ToolUse = { id: "toolu_no_scope", name: "read", arguments: { path: "a" } };
	const waiting = createFakeRun(t, [...toToolUseMessage([call]), callTool(call), REPLY]);
	const stdinDir = mkdtempSync(join(tmpdir(), "claude-unscoped-replay-"));
	t.after(() => rmSync(stdinDir, { recursive: true, force: true }));
	const stdinFile = join(stdinDir, "stdin.jsonl");
	const fresh = createFakeRun(t, readFixtureLines("text.jsonl"), { FAKE_CLAUDE_STDIN: stdinFile });
	const stream = createClaudeCodeStreamFunction((args, options) => (waiting.calls.length === 0 ? waiting : fresh).runClaude(args, options));
	const message = await runTurn(stream, [HI], { sessionId: undefined });
	await assertCleanedUp(getOnlyCall(waiting.calls));
	const reply = await runTurn(stream, [HI, message, toToolResult(call, "the preserved answer")], { sessionId: undefined });
	assert.equal(reply.stopReason, "stop");
	assert.equal(fresh.calls.length, 1);
	assert.match(readFileSync(stdinFile, "utf8"), /the preserved answer/);
	await assertCleanedUp(getOnlyCall(fresh.calls));
});

test("CLI window metadata stays on its own process and survives a held-tool continuation", async (t) => {
	const read: ToolUse = { id: "toolu_window", name: "read", arguments: { path: "one" } };
	const one = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY], { FAKE_CLAUDE_WINDOW: "200000" });
	const two = createFakeRun(t, [...toToolUseMessage([read]), callTool(read), REPLY], { FAKE_CLAUDE_WINDOW: "750000" });
	let spawns = 0;
	const stream = createClaudeCodeStreamFunction((args, opts) => (++spawns === 1 ? one : two).runClaude(args, opts));
	const window = (m: AssistantMessage) => (m as AssistantMessage & { cliContextWindow?: number }).cliContextWindow;
	const a = await runTurn(stream, [HI], { sessionId: "context-one" });
	const b = await runTurn(stream, [HI], { sessionId: "context-two" });
	assert.equal(window(a), 200000); assert.equal(window(b), 750000);
	const ra = await runTurn(stream, [HI, a, toToolResult(read, "a")], { sessionId: "context-one" });
	const rb = await runTurn(stream, [HI, b, toToolResult(read, "b")], { sessionId: "context-two" });
	assert.equal(window(ra), 200000); assert.equal(window(rb), 750000); assert.equal(spawns, 2);
});

for (const extraEnv of [{ FAKE_CLAUDE_INIT: "error" }, { FAKE_CLAUDE_WINDOW: "-1" }, {}] as Record<string, string>[]) test(`missing/unsupported CLI window never prevents a normal response: ${JSON.stringify(extraEnv)}`, async (t) => {
	const { events } = await runScenario(t, readFixtureLines("text.jsonl"), undefined, extraEnv);
	const result = getLastEvent(events);
	assert.equal(result.type, "done");
	assert(!("cliContextWindow" in (result.type === "done" ? result.message : {})));
});

for (const sharedIdentity of [false, true]) test(`two concurrent stream owners keep separate processes${sharedIdentity ? " even with identical call IDs and arguments" : ""}`, async (t) => {
	const readOne: ToolUse = { id: "toolu_concurrent_one", name: "read", arguments: { path: "one" } };
	const readTwo: ToolUse = sharedIdentity ? { ...readOne } : { id: "toolu_concurrent_two", name: "read", arguments: { path: "two" } };
	const one = createFakeRun(t, [...toToolUseMessage([readOne]), callTool(readOne), REPLY]);
	const two = createFakeRun(t, [...toToolUseMessage([readTwo]), callTool(readTwo), REPLY]);

	const streamOne = createClaudeCodeStreamFunction(one.runClaude);
	const streamTwo = createClaudeCodeStreamFunction(two.runClaude);
	const [toolMessageOne, toolMessageTwo] = await Promise.all([runTurn(streamOne, [HI]), runTurn(streamTwo, [HI])]);

	const [replyOne, replyTwo] = await Promise.all([
		runTurn(streamOne, [HI, toolMessageOne, toToolResult(readOne, "from one")]),
		runTurn(streamTwo, [HI, toolMessageTwo, toToolResult(readTwo, "from two")]),
	]);

	assert.equal(getText(replyOne), "from one");
	assert.equal(getText(replyTwo), "from two");
	assert.equal(one.calls.length, 1);
	assert.equal(two.calls.length, 1);
});

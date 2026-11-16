/**
 * Codex stream function (src/agent/codex/stream.ts) and the app-server protocol layer
 * (src/agent/codex/app-server.ts).
 *
 * The runCodex seam spawns tests/fixtures/codex/fake-codex.mjs, which speaks the JSON-RPC
 * lines of `codex app-server` (CLI 0.165.0), so the real process plumbing (argv, stdin,
 * stdout lines, stderr, exit, kill) runs end to end. No real Codex and no inference.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	JsonObject,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { CODEX_MINIMUM_VERSION, createCodexLauncher, createCodexStreamFunction, type RunCodex } from "../src/agent/codex/stream.ts";
import { authEnvRecord } from "../src/core/auth-env.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/codex/fake-codex.mjs", import.meta.url));
const CLEANUP_TIMEOUT_MS = 2000;
const HOLD_MS = 400;

const SESSION_ID = "codex-stream-test-chat";
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const ASK_TOOL: Tool = { name: "ask_user_question", description: "Ask the learner", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const THREAD_ID = "thr_1";
const TURN_ID = "turn_1";
const HOLD = JSON.stringify({ fake: "hold" });
const REPLY = JSON.stringify({ fake: "reply" });
const DISABLED_FEATURES = [
	"shell_tool", "unified_exec", "view_image", "apps", "browser_use", "browser_use_external",
	"computer_use", "image_generation", "memories", "plugins", "hooks",
];

type ToolUse = { id: string; rpcId: string | number; name: string; arguments: JsonObject };

type RunCall = {
	args: string[];
	cwd: string;
	cwdEntries: string[];
	env: NodeJS.ProcessEnv;
	stdinFile: string;
	child: ChildProcessWithoutNullStreams;
};

function notification(method: string, params: object): string {
	return JSON.stringify({ method, params: { threadId: THREAD_ID, turnId: TURN_ID, ...params } });
}

function textDelta(delta: string): string {
	return notification("item/agentMessage/delta", { itemId: "msg_1", delta });
}

function reasoningDelta(delta: string): string {
	return notification("item/reasoning/textDelta", { itemId: "rs_1", contentIndex: 0, delta });
}

function itemStarted(item: object): string {
	return notification("item/started", { item, startedAtMs: 0 });
}

function itemCompleted(item: object): string {
	return notification("item/completed", { item, startedAtMs: 0 });
}

const TURN_COMPLETED = notification("turn/completed", { turn: { id: TURN_ID, status: "completed", items: [] } });

function callTool(toolUse: ToolUse): string {
	return JSON.stringify({ fake: "call", rpcId: toolUse.rpcId, callId: toolUse.id, name: toolUse.name, arguments: toolUse.arguments });
}

function toToolResult(toolUse: ToolUse, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: toolUse.id, toolName: toolUse.name, content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

function getModel(): Model<Api> {
	const base = CLAUDE_CODE_MODELS[0];
	assert.ok(base);
	return { ...base, id: "gpt-5-codex", name: "GPT-5 Codex" };
}

function createFakeRun(t: TestContext, scenario: string[], extraEnv: Record<string, string> = {}): { runCodex: RunCodex; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const calls: RunCall[] = [];
	const runCodex: RunCodex = (args, options) => {
		const stdinFile = join(dir, `stdin-${calls.length}.jsonl`);
		const child = spawn(process.execPath, [FAKE_CODEX, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CODEX_SCENARIO: scenarioFile, FAKE_CODEX_STDIN: stdinFile, ...extraEnv },
			stdio: "pipe",
		});
		t.after(() => child.kill("SIGKILL"));
		calls.push({ args, cwd: options.cwd, cwdEntries: readdirSync(options.cwd), env: options.env, stdinFile, child });
		return child;
	};

	return { runCodex, calls };
}

async function collectEvents(stream: AssistantMessageEventStream, onEvent: (event: AssistantMessageEvent) => void = () => {}): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		onEvent(event);
	}
	return events;
}

function getContext(messages: Message[]) {
	return normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL, ASK_TOOL] });
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

async function runTurn(streamFunction: StreamFunction<Api, SimpleStreamOptions>, messages: Message[], options?: SimpleStreamOptions): Promise<AssistantMessage> {
	const done = getLastEvent(await collectEvents(streamFunction(getModel(), getContext(messages), { sessionId: SESSION_ID, ...options })));
	assert.ok(done.type === "done", `turn ended with ${done.type}: ${done.type === "error" ? done.error.errorMessage : ""}`);
	return done.message;
}

function getText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function getOnlyCall(calls: RunCall[]): RunCall {
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.ok(call);
	return call;
}

/** Every JSON-RPC line the fake read from stdin. */
function readStdin(call: RunCall): { id?: string | number; method?: string; params?: any; result?: any }[] {
	return readFileSync(call.stdinFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function getRequest(call: RunCall, method: string) {
	const request = readStdin(call).find((message) => message.method === method);
	assert.ok(request, `no ${method} request`);
	return request;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }), "codex process was not killed");
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
}

async function runScenario(t: TestContext, scenario: string[], options?: SimpleStreamOptions, extraEnv?: Record<string, string>) {
	const { runCodex, calls } = createFakeRun(t, scenario, extraEnv);
	const events = await collectEvents(createCodexStreamFunction(runCodex)(getModel(), getContext([HI]), { sessionId: SESSION_ID, ...options }));
	return { events, calls };
}

test("text streams as several deltas before done, with reasoning as thinking", async (t) => {
	const { events, calls } = await runScenario(t, [
		reasoningDelta("pondering"),
		itemStarted({ type: "agentMessage", id: "msg_1", text: "", phase: null }),
		textDelta("Hel"), textDelta("lo "), textDelta("world"),
		itemCompleted({ type: "agentMessage", id: "msg_1", text: "Hello world", phase: null }),
		TURN_COMPLETED,
		HOLD,
	]);

	const types = events.map((event) => event.type);
	assert.equal(types.filter((type) => type === "text_delta").length, 3);
	assert.ok(types.includes("thinking_delta"));
	assert.ok(types.lastIndexOf("text_delta") < types.indexOf("done"), "every text delta arrives before done");
	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.equal(done.reason, "stop");
	assert.equal(getText(done.message), "Hello world");
	await assertCleanedUp(getOnlyCall(calls));
});

test("a harness tool call becomes a pi toolcall and its result returns to the same child as a JSON-RPC response", async (t) => {
	const read: ToolUse = { id: "call_read_1", rpcId: "req-1", name: "read", arguments: { path: "a" } };
	const { runCodex, calls } = createFakeRun(t, [textDelta("Let me read."), callTool(read), REPLY]);
	const streamFunction = createCodexStreamFunction(runCodex);

	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.equal(toolMessage.stopReason, "toolUse");
	assert.deepEqual(toolMessage.content.filter((block) => block.type === "toolCall"), [{ type: "toolCall", id: read.id, name: "read", arguments: { path: "a" } }]);

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(read, "contents of a")]);
	assert.equal(getText(reply), "contents of a");

	const call = getOnlyCall(calls);
	const response = readStdin(call).find((message) => message.method === undefined && message.id === "req-1");
	assert.deepEqual(response, { id: "req-1", result: { contentItems: [{ type: "inputText", text: "contents of a" }], success: true } });
	await assertCleanedUp(call);
});

for (const [name, scenario] of [
	["a built-in tool item", [textDelta("x"), itemStarted({ type: "commandExecution", id: "cmd_1", command: "ls", status: "inProgress" }), HOLD]],
	["a built-in approval request", [JSON.stringify({ fake: "native-request", rpcId: 9, method: "item/commandExecution/requestApproval" }), HOLD]],
] as const) {
	test(`${name} fails the turn and cleans the child up`, async (t) => {
		const { events, calls } = await runScenario(t, [...scenario]);
		assert.match(getErrorMessage(events) ?? "", /unsupported native tool call/);
		await assertCleanedUp(getOnlyCall(calls));
	});
}

test("a CLI below the minimum version is refused with the Codex version and the minimum in the error", async (t) => {
	const { runCodex, calls } = createFakeRun(t, [TURN_COMPLETED]);
	let spawned = 0;
	const refused = createCodexLauncher({
		findBinary: () => FAKE_CODEX,
		readVersion: async () => "codex-cli 0.164.9",
		spawnProcess: ((...args: Parameters<typeof spawn>) => { spawned += 1; return spawn(...args); }) as typeof spawn,
	});
	const events = await collectEvents(createCodexStreamFunction(refused)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));

	const message = getErrorMessage(events) ?? "";
	assert.match(message, /Codex 0\.164\.9/);
	assert.ok(message.includes(CODEX_MINIMUM_VERSION) && CODEX_MINIMUM_VERSION === "0.165.0");
	assert.doesNotMatch(message, /Claude|failed to start/);
	assert.equal(spawned, 0);
	assert.equal(calls.length, 0);

	// The minimum itself passes the gate and reaches the process.
	const accepted = createCodexLauncher({
		findBinary: () => FAKE_CODEX,
		readVersion: async () => "codex-cli 0.165.0",
		spawnProcess: ((_binary: string, args: string[], options: object) => runCodex(args, options as never)) as typeof spawn,
	});
	const ok = await collectEvents(createCodexStreamFunction(accepted)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));
	assert.equal(getLastEvent(ok).type, "done");
	assert.equal(calls.length, 1);
});

test("abort kills the process and removes the temp dir", async (t) => {
	const { runCodex, calls } = createFakeRun(t, [textDelta("partial"), HOLD]);
	const controller = new AbortController();
	const stream = createCodexStreamFunction(runCodex)(getModel(), getContext([HI]), { signal: controller.signal });
	const events = await collectEvents(stream, (event) => { if (event.type === "start") controller.abort(); });

	const error = getLastEvent(events);
	assert.ok(error.type === "error");
	assert.equal(error.reason, "aborted");
	await assertCleanedUp(getOnlyCall(calls));
});

test("the arguments and thread config turn the built-in tools, user MCP servers and plugins off", async (t) => {
	const { events, calls } = await runScenario(t, [textDelta("ok"), TURN_COMPLETED, HOLD]);
	assert.equal(getLastEvent(events).type, "done");
	const call = getOnlyCall(calls);

	assert.equal(call.args[0], "app-server");
	for (const feature of DISABLED_FEATURES) {
		assert.ok(call.args.some((arg, index) => arg === "--disable" && call.args[index + 1] === feature), `--disable ${feature}`);
	}
	for (const override of ['web_search="disabled"', "project_doc_max_bytes=0", "include_apps_instructions=false"]) {
		assert.ok(call.args.some((arg, index) => arg === "-c" && call.args[index + 1] === override), `-c ${override}`);
	}

	const methods = readStdin(call).map((message) => message.method);
	assert.deepEqual(methods, ["initialize", "initialized", "config/read", "thread/start", "turn/start"]);
	const thread = getRequest(call, "thread/start").params;
	assert.equal(thread.sandbox, "read-only");
	assert.equal(thread.approvalPolicy, "never");
	assert.equal(thread.ephemeral, true);
	assert.equal(thread.cwd, call.cwd);
	assert.equal(thread.model, "gpt-5-codex");
	assert.equal(thread.baseInstructions, "You are a tutor.");
	assert.deepEqual(thread.config, {
		mcp_servers: { serena: { enabled: false }, blender: { enabled: false } },
		plugins: { "github@openai": { enabled: false } },
	});
	assert.deepEqual(thread.dynamicTools.map((tool: { name: string }) => tool.name), ["read", "ask_user_question"]);
	assert.deepEqual(thread.dynamicTools[0], { type: "function", name: "read", description: "Read a file", inputSchema: READ_TOOL.parameters });
	assert.deepEqual(getRequest(call, "turn/start").params, { threadId: THREAD_ID, input: [{ type: "text", text: "hi", text_elements: [] }], model: "gpt-5-codex" });
});

test("only the servers and plugins config/read names are disabled", async (t) => {
	const config = JSON.stringify({ mcp_servers: { only: {} } });
	const { calls } = await runScenario(t, [textDelta("ok"), TURN_COMPLETED, HOLD], undefined, { FAKE_CODEX_CONFIG: config });
	assert.deepEqual(getRequest(getOnlyCall(calls), "thread/start").params.config, { mcp_servers: { only: { enabled: false } }, plugins: {} });
});

test("env keeps LearnHarness-only keys out and the cwd is an empty temp dir", async (t) => {
	const names = ["OPENAI_API_KEY", "CODEX_API_KEY"];
	const record = authEnvRecord();
	const saved = names.map((name) => process.env[name]);
	t.after(() => names.forEach((name, index) => {
		record.fillGap.delete(name);
		if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
	}));
	for (const name of names) { process.env[name] = "lh-only-key"; record.fillGap.add(name); }

	const { calls } = await runScenario(t, [textDelta("ok"), TURN_COMPLETED, HOLD]);
	const call = getOnlyCall(calls);
	for (const name of names) assert.equal(call.env[name], undefined, `${name} must not reach the CLI`);
	assert.ok(!JSON.stringify(call.args).includes("lh-only-key"));
	assert.deepEqual(call.cwdEntries, []);
	assert.equal(dirname(call.cwd), tmpdir());
	assert.match(basename(call.cwd), /^codex-cwd-/);
});

test("a held ask_user_question call is neither timed out nor killed, and its answer returns on the same request id and child", async (t) => {
	const ask: ToolUse = { id: "call_ask_1", rpcId: 7, name: "ask_user_question", arguments: { question: "Which?" } };
	const { runCodex, calls } = createFakeRun(t, [callTool(ask), REPLY]);
	const streamFunction = createCodexStreamFunction(runCodex);

	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.equal(toolMessage.stopReason, "toolUse");

	await sleep(HOLD_MS);
	const call = getOnlyCall(calls);
	assert.equal(call.child.exitCode, null);
	assert.equal(call.child.signalCode, null);
	assert.ok(existsSync(call.cwd));
	assert.ok(!readStdin(call).some((message) => message.method === undefined), "nothing was answered while the learner thinks");

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(ask, "the second")]);
	assert.equal(getText(reply), "the second");
	assert.equal(calls.length, 1, "the same child process served both pi turns");
	const response = readStdin(call).find((message) => message.method === undefined && message.id === 7);
	assert.deepEqual(response, { id: 7, result: { contentItems: [{ type: "inputText", text: "the second" }], success: true } });
	await assertCleanedUp(call);
});

function callsDirective(toolUses: (ToolUse & { delayMs?: number })[]): string {
	return JSON.stringify({ fake: "calls", calls: toolUses.map((use) => ({ rpcId: use.rpcId, callId: use.id, name: use.name, arguments: use.arguments, delayMs: use.delayMs })) });
}

function getToolCallIds(message: AssistantMessage): string[] {
	return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

function getResponse(call: RunCall, rpcId: string | number) {
	return readStdin(call).find((message) => message.method === undefined && message.id === rpcId);
}

/** The fake child records its stdin from another process, so a response can land after pi's next message. */
async function waitForResponse(call: RunCall, rpcId: string | number) {
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	for (;;) {
		const response = getResponse(call, rpcId);
		if (response !== undefined || Date.now() >= deadline) return response;
		await sleep(10);
	}
}

test("parallel tool calls share one pi message and each result answers its own request id on the same child", async (t) => {
	const first: ToolUse = { id: "call_p1", rpcId: "req-p1", name: "read", arguments: { path: "one" } };
	const second: ToolUse = { id: "call_p2", rpcId: "req-p2", name: "read", arguments: { path: "two" } };
	const { runCodex, calls } = createFakeRun(t, [callsDirective([first, second]), REPLY]);
	const streamFunction = createCodexStreamFunction(runCodex);

	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.equal(toolMessage.stopReason, "toolUse");
	assert.deepEqual(getToolCallIds(toolMessage), [first.id, second.id]);

	// Results come back in the opposite order: they are matched by callId, not by position.
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(second, "contents of two"), toToolResult(first, "contents of one")]);
	assert.equal(getText(reply), "contents of one | contents of two");

	const call = getOnlyCall(calls);
	assert.deepEqual(await waitForResponse(call, first.rpcId), { id: first.rpcId, result: { contentItems: [{ type: "inputText", text: "contents of one" }], success: true } });
	assert.deepEqual(await waitForResponse(call, second.rpcId), { id: second.rpcId, result: { contentItems: [{ type: "inputText", text: "contents of two" }], success: true } });
	await assertCleanedUp(call);
});

test("a call that arrives after pi has the first message is handed to pi in the next message on the same child", async (t) => {
	const first: ToolUse = { id: "call_q1", rpcId: "req-q1", name: "read", arguments: { path: "one" } };
	const late: ToolUse & { delayMs: number } = { id: "call_q2", rpcId: "req-q2", name: "read", arguments: { path: "two" }, delayMs: HOLD_MS / 2 };
	const { runCodex, calls } = createFakeRun(t, [callsDirective([first, late]), REPLY]);
	const streamFunction = createCodexStreamFunction(runCodex);

	const firstMessage = await runTurn(streamFunction, [HI]);
	assert.deepEqual(getToolCallIds(firstMessage), [first.id]);
	await sleep(HOLD_MS);
	const call = getOnlyCall(calls);
	assert.equal(getResponse(call, late.rpcId), undefined, "the queued call is not answered by itself");

	const secondMessage = await runTurn(streamFunction, [HI, firstMessage, toToolResult(first, "contents of one")]);
	assert.equal(secondMessage.stopReason, "toolUse");
	assert.deepEqual(getToolCallIds(secondMessage), [late.id]);
	assert.deepEqual(await waitForResponse(call, first.rpcId), { id: first.rpcId, result: { contentItems: [{ type: "inputText", text: "contents of one" }], success: true } });

	const reply = await runTurn(streamFunction, [HI, firstMessage, toToolResult(first, "contents of one"), secondMessage, toToolResult(late, "contents of two")]);
	assert.equal(getText(reply), "contents of one | contents of two");
	assert.deepEqual(await waitForResponse(call, late.rpcId), { id: late.rpcId, result: { contentItems: [{ type: "inputText", text: "contents of two" }], success: true } });
	assert.equal(calls.length, 1, "one child served every message");
	await assertCleanedUp(call);
});

async function getTurnStartParams(t: TestContext, reasoning: SimpleStreamOptions["reasoning"]) {
	const { calls } = await runScenario(t, [textDelta("ok"), TURN_COMPLETED, HOLD], { reasoning });
	return getRequest(getOnlyCall(calls), "turn/start").params;
}

test("a thinking level the model maps to a Codex effort is sent as the effort of turn/start", async (t) => {
	const params = await getTurnStartParams(t, "high");
	assert.equal(params.effort, "high");
});

test("no thinking level, or a level the model maps to null, sends no effort", async (t) => {
	assert.ok(!("effort" in (await getTurnStartParams(t, undefined))), "no level: no effort");
	assert.equal(getModel().thinkingLevelMap?.minimal, null, "the test model maps minimal to null");
	assert.ok(!("effort" in (await getTurnStartParams(t, "minimal"))), "a null level: no effort");
});

test("changing the thinking level changes the effort Codex receives", async (t) => {
	assert.equal((await getTurnStartParams(t, "high")).effort, "high");
	assert.equal((await getTurnStartParams(t, "low")).effort, "low");
});

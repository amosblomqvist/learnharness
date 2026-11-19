/**
 * Gemini CLI stream function (src/agent/gemini-cli/stream.ts, events.ts).
 *
 * The runGemini seam spawns tests/fixtures/gemini-cli/fake-gemini.mjs, which prints the
 * stream-json lines of Gemini CLI 0.68.0 and calls the tool bridge over HTTP MCP with the real
 * MCP SDK client, so argv, stdin, stdout lines, exit, kill and the tool bridge run end to end.
 * No real Gemini CLI and no inference.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
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
import { GeminiInstallKind, resolveGeminiInstall } from "../src/agent/gemini-cli/binary.ts";
import { GEMINI_BUILTIN_TOOLS, GEMINI_CLI_MINIMUM_VERSION, NODE_MISSING_MESSAGE, createGeminiCliStreamFunction, createGeminiLauncher, type RunGemini } from "../src/agent/gemini-cli/stream.ts";
import { authEnvRecord } from "../src/core/auth-env.ts";

const FAKE_GEMINI = fileURLToPath(new URL("./fixtures/gemini-cli/fake-gemini.mjs", import.meta.url));
const CLEANUP_TIMEOUT_MS = 2000;

const SESSION_ID = "gemini-cli-stream-test-chat";
const SYSTEM_PROMPT = "You are a tutor.";
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const WEB_FETCH_TOOL: Tool = { name: "web_fetch", description: "Fetch a page", parameters: { type: "object", properties: { url: { type: "string" } } } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const HOLD = JSON.stringify({ fake: "hold" });
const CONNECT = JSON.stringify({ fake: "connect" });
const REPLY = JSON.stringify({ fake: "reply" });
const MCP_PREFIX = "mcp_learnharness_";

type ToolUse = { id: string; name: string; arguments: JsonObject };

type RunCall = {
	args: string[];
	cwd: string;
	cwdEntries: string[];
	env: NodeJS.ProcessEnv;
	recordFile: string;
	child: ChildProcessWithoutNullStreams;
};

type FakeRecord = { argv: string[]; stdin: string; systemMd: string | null; settings: string | null };

function line(value: object): string {
	return JSON.stringify({ type: "x", timestamp: "2026-01-01T00:00:00.000Z", ...value });
}

const INIT = line({ type: "init", session_id: "s1", model: "gemini-2.5-pro" });
const SUCCESS = line({ type: "result", status: "success", stats: {} });

function assistant(content: string): string {
	return line({ type: "message", role: "assistant", content, delta: true });
}

function mcpCall(use: ToolUse, extra: object = {}): string {
	return JSON.stringify({ fake: "mcp-call", id: use.id, name: use.name, arguments: use.arguments, ...extra });
}

function toolUse(use: ToolUse): string {
	return JSON.stringify({ fake: "tool-use", id: use.id, tool_name: `${MCP_PREFIX}${use.name}`, parameters: use.arguments });
}

function callTool(use: ToolUse): string {
	return JSON.stringify({ fake: "call", id: use.id, name: use.name, arguments: use.arguments });
}

function awaitCalls(...uses: ToolUse[]): string {
	return JSON.stringify({ fake: "await", ids: uses.map((use) => use.id) });
}

function toToolResult(use: ToolUse, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: use.id, toolName: use.name, content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

function getModel(id = "gemini-2.5-pro"): Model<Api> {
	const base = CLAUDE_CODE_MODELS[0];
	assert.ok(base);
	return { ...base, id, name: id };
}

function createFakeRun(t: TestContext, scenario: string[], extraEnv: Record<string, string> = {}): { runGemini: RunGemini; calls: RunCall[] } {
	const dir = mkdtempSync(join(tmpdir(), "gemini-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const calls: RunCall[] = [];
	const runGemini: RunGemini = (args, options) => {
		const recordFile = join(dir, `record-${calls.length}.json`);
		const child = spawn(process.execPath, [FAKE_GEMINI, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_GEMINI_SCENARIO: scenarioFile, FAKE_GEMINI_RECORD: recordFile, ...extraEnv },
			stdio: "pipe",
		});
		t.after(() => child.kill("SIGKILL"));
		calls.push({ args, cwd: options.cwd, cwdEntries: readdirSync(options.cwd), env: options.env, recordFile, child });
		return child;
	};

	return { runGemini, calls };
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
	return normalizeContext({ systemPrompt: SYSTEM_PROMPT, messages, tools: [READ_TOOL, WEB_FETCH_TOOL] });
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

function getToolCalls(message: AssistantMessage) {
	return message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
}

function getOnlyCall(calls: RunCall[]): RunCall {
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.ok(call);
	return call;
}

function readRecord(call: RunCall): FakeRecord {
	return JSON.parse(readFileSync(call.recordFile, "utf8"));
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }), "gemini process was not killed");
}

async function waitForRemoval(path: string): Promise<void> {
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	while (existsSync(path)) {
		assert.ok(Date.now() < deadline, `${path} was not removed`);
		await sleep(10);
	}
}

/** The child is gone and both temp dirs (the empty cwd and the private dir of the system prompt and settings) are removed. */
async function assertCleanedUp(call: RunCall): Promise<void> {
	await waitForExit(call.child);
	await waitForRemoval(call.cwd);
	assert.ok(call.env.GEMINI_SYSTEM_MD, "the launch names the system prompt file in the child's env");
	await waitForRemoval(dirname(call.env.GEMINI_SYSTEM_MD));
}

async function runScenario(t: TestContext, scenario: string[], options?: SimpleStreamOptions, extraEnv?: Record<string, string>) {
	const { runGemini, calls } = createFakeRun(t, scenario, extraEnv);
	const events = await collectEvents(createGeminiCliStreamFunction(runGemini)(getModel(), getContext([HI]), { sessionId: SESSION_ID, ...options }));
	return { events, calls };
}

test("text streams as several deltas before done", async (t) => {
	const { events, calls } = await runScenario(t, [
		INIT,
		line({ type: "message", role: "user", content: "hi" }),
		assistant("Hel"), assistant("lo "), assistant("world"),
		SUCCESS,
		HOLD,
	]);

	const types = events.map((event) => event.type);
	assert.equal(types.filter((type) => type === "text_delta").length, 3);
	assert.ok(types.lastIndexOf("text_delta") < types.indexOf("done"), "every text delta arrives before done");
	const done = getLastEvent(events);
	assert.ok(done.type === "done");
	assert.equal(done.reason, "stop");
	assert.equal(getText(done.message), "Hello world");
	assert.equal(readRecord(getOnlyCall(calls)).stdin.trim(), "hi");
	await waitForExit(getOnlyCall(calls).child);
});

test("a harness tool call becomes a pi toolcall and its result returns to the same child's MCP request", async (t) => {
	const read: ToolUse = { id: "t_read", name: "read", arguments: { path: "a" } };
	const { runGemini, calls } = createFakeRun(t, [INIT, assistant("Let me read."), callTool(read), REPLY]);
	const streamFunction = createGeminiCliStreamFunction(runGemini);

	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.equal(toolMessage.stopReason, "toolUse");
	assert.deepEqual(getToolCalls(toolMessage), [{ type: "toolCall", id: read.id, name: "read", arguments: { path: "a" } }]);

	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(read, "contents of a")]);
	assert.equal(getText(reply), "contents of a");
	assert.equal(calls.length, 1, "the same child continues");
	await waitForExit(getOnlyCall(calls).child);
});

test("the LearnHarness web_fetch passes while Gemini's own web_fetch stops the turn", async (t) => {
	const fetchUse: ToolUse = { id: "t_fetch", name: "web_fetch", arguments: { url: "https://example.com" } };
	const { runGemini, calls } = createFakeRun(t, [INIT, callTool(fetchUse), REPLY]);
	const streamFunction = createGeminiCliStreamFunction(runGemini);
	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.deepEqual(getToolCalls(toolMessage).map((call) => call.name), ["web_fetch"]);
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(fetchUse, "page")]);
	assert.equal(getText(reply), "page");
	await waitForExit(getOnlyCall(calls).child);

	const builtIn = await runScenario(t, [INIT, JSON.stringify({ fake: "tool-use", id: "t_b", tool_name: "web_fetch", parameters: { url: "https://example.com" } }), HOLD]);
	assert.match(getErrorMessage(builtIn.events) ?? "", /unsupported native tool call/);
	await waitForExit(getOnlyCall(builtIn.calls).child);
});

for (const [name, toolName] of [
	["a built-in tool", "read_file"],
	["a built-in tool named like a harness tool", "read"],
	["a tool of another MCP server", "mcp_other_read"],
] as const) {
	test(`${name} in a tool_use fails the turn and cleans the child and the temp dirs up`, async (t) => {
		const { events, calls } = await runScenario(t, [INIT, assistant("x"), JSON.stringify({ fake: "tool-use", id: "t_n", tool_name: toolName, parameters: {} }), HOLD]);
		assert.match(getErrorMessage(events) ?? "", /unsupported native tool call/);
		await assertCleanedUp(getOnlyCall(calls));
	});
}

test("a CLI below the minimum version is refused with its version and the minimum in the error", async (t) => {
	const { runGemini, calls } = createFakeRun(t, [INIT, SUCCESS]);
	let spawned = 0;
	const refused = createGeminiLauncher({
		findBinary: () => FAKE_GEMINI,
		readVersion: async () => "0.67.9",
		spawnProcess: ((...args: Parameters<typeof spawn>) => { spawned += 1; return spawn(...args); }) as typeof spawn,
	});
	const events = await collectEvents(createGeminiCliStreamFunction(refused)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));

	const message = getErrorMessage(events) ?? "";
	assert.match(message, /Gemini CLI 0\.67\.9/);
	assert.ok(message.includes(GEMINI_CLI_MINIMUM_VERSION) && GEMINI_CLI_MINIMUM_VERSION === "0.68.0");
	assert.doesNotMatch(message, /Claude|failed to start/);
	assert.equal(spawned, 0);
	assert.equal(calls.length, 0);

	const accepted = createGeminiLauncher({
		findBinary: () => FAKE_GEMINI,
		readVersion: async () => "0.68.0",
		spawnProcess: ((_binary: string, args: string[], options: object) => runGemini(args, options as never)) as typeof spawn,
	});
	const ok = await collectEvents(createGeminiCliStreamFunction(accepted)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));
	assert.equal(getLastEvent(ok).type, "done");
	assert.equal(calls.length, 1);
});

test("abort kills the process and removes the temp dirs", async (t) => {
	const { runGemini, calls } = createFakeRun(t, [INIT, assistant("partial"), HOLD]);
	const controller = new AbortController();
	const events = await collectEvents(
		createGeminiCliStreamFunction(runGemini)(getModel(), getContext([HI]), { sessionId: SESSION_ID, signal: controller.signal }),
		(event) => { if (event.type === "text_delta") controller.abort(); },
	);
	assert.equal(getLastEvent(events).type, "error");
	const call = getOnlyCall(calls);
	await assertCleanedUp(call);
});

test("argv, settings and the system prompt: only the LearnHarness MCP server, no built-in tool, the system prompt by file", async (t) => {
	const { runGemini, calls } = createFakeRun(t, [INIT, SUCCESS, HOLD]);
	const model = getModel("flash");
	await collectEvents(createGeminiCliStreamFunction(runGemini)(model, getContext([HI]), { sessionId: SESSION_ID }));
	const call = getOnlyCall(calls);
	const record = readRecord(call);

	assert.deepEqual(call.args, ["--output-format", "stream-json", "--model", "flash", "--extensions", "none", "--allowed-mcp-server-names", "learnharness", "--skip-trust"]);
	assert.ok(!call.args.includes("--yolo") && !call.args.includes("--approval-mode") && !call.args.includes("-y"));
	assert.equal(record.systemMd, SYSTEM_PROMPT);

	assert.ok(record.settings);
	const settings = JSON.parse(record.settings);
	assert.deepEqual(Object.keys(settings.mcpServers), ["learnharness"]);
	const server = settings.mcpServers.learnharness;
	assert.match(server.httpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.match(server.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
	assert.equal(server.trust, true);
	assert.deepEqual(settings.mcp, { allowed: ["learnharness"] });
	// No built-in tool is allowed: the allowlist holds only the LearnHarness server's tools.
	assert.deepEqual(settings.tools.core, [`${MCP_PREFIX}*`]);
	for (const name of ["read_file", "run_shell_command", "write_file", "web_fetch", "google_web_search", "glob", "grep_search", "list_directory"]) {
		assert.ok(settings.tools.exclude.includes(name), `${name} is excluded`);
	}
	assert.deepEqual(settings.tools.exclude, GEMINI_BUILTIN_TOOLS);
	assert.ok(settings.tools.exclude.every((name: string) => !name.startsWith("mcp_")), "no MCP tool is excluded, so the LearnHarness web_fetch stays");

	// The system prompt and settings files are named by env, in a private dir apart from the cwd.
	assert.ok(call.env.GEMINI_SYSTEM_MD && call.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
	assert.notEqual(dirname(call.env.GEMINI_SYSTEM_MD), call.cwd);
	assert.equal(dirname(call.env.GEMINI_SYSTEM_MD), dirname(call.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH));
	await assertCleanedUp(call);
});

test("the child env has no LearnHarness key and the cwd is a temp dir holding only empty .env stop files", async (t) => {
	const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
	const record = authEnvRecord();
	const saved = names.map((name) => process.env[name]);
	t.after(() => names.forEach((name, index) => {
		record.fillGap.delete(name);
		if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
	}));
	for (const name of names) { process.env[name] = "lh-only-key"; record.fillGap.add(name); }

	const { events, calls } = await runScenario(t, [INIT, SUCCESS, HOLD]);
	assert.equal(getLastEvent(events).type, "done");
	const call = getOnlyCall(calls);
	for (const name of names) assert.equal(call.env[name], undefined, `${name} must not reach the child`);
	assert.ok(!JSON.stringify(call.args).includes("lh-only-key"));
	assert.equal(dirname(call.cwd), tmpdir());
	// `.env` stops an untrusted lookup, `.gemini/.env` a trusted one; both must be empty.
	assert.deepEqual([...call.cwdEntries].sort(), [".env", ".gemini"]);
	assert.deepEqual(readdirSync(join(call.cwd, ".gemini")), [".env"]);
	assert.equal(readFileSync(join(call.cwd, ".gemini", ".env"), "utf8"), "");
	assert.equal(readFileSync(join(call.cwd, ".env"), "utf8"), "");
	// Trusted, the CLI stops at the empty .gemini/.env even when a user setting ignores local .env files.
	assert.equal(call.env.GEMINI_CLI_TRUST_WORKSPACE, "true");
	await assertCleanedUp(call);
});

test("an inherited GEMINI_RESTRICTED_MODE=true does not reach the child, so the cwd stays trusted", async (t) => {
	const saved = process.env.GEMINI_RESTRICTED_MODE;
	t.after(() => { if (saved === undefined) delete process.env.GEMINI_RESTRICTED_MODE; else process.env.GEMINI_RESTRICTED_MODE = saved; });
	process.env.GEMINI_RESTRICTED_MODE = "true";

	const { events, calls } = await runScenario(t, [INIT, SUCCESS, HOLD]);
	assert.equal(getLastEvent(events).type, "done");
	const call = getOnlyCall(calls);
	// "true" would outrank GEMINI_CLI_TRUST_WORKSPACE and let the CLI skip the empty .gemini/.env.
	assert.equal(call.env.GEMINI_RESTRICTED_MODE, "false");
	assert.equal(call.env.GEMINI_CLI_TRUST_WORKSPACE, "true");
	await assertCleanedUp(call);
});

test("an MCP request that arrives before its tool_use still pairs with it", async (t) => {
	const read: ToolUse = { id: "t_early", name: "read", arguments: { path: "early" } };
	const { runGemini } = createFakeRun(t, [INIT, mcpCall(read, { wait: false }), JSON.stringify({ fake: "sleep", ms: 100 }), toolUse(read), awaitCalls(read), REPLY]);
	const streamFunction = createGeminiCliStreamFunction(runGemini);
	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.deepEqual(getToolCalls(toolMessage).map((call) => call.id), [read.id]);
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(read, "early result")]);
	assert.equal(getText(reply), "early result");
});

test("two different calls whose MCP requests arrive in the opposite order are paired by name and arguments", async (t) => {
	const first: ToolUse = { id: "t_x", name: "read", arguments: { path: "x" } };
	const second: ToolUse = { id: "t_y", name: "read", arguments: { path: "y" } };
	const { runGemini } = createFakeRun(t, [
		INIT, CONNECT, toolUse(first), toolUse(second),
		mcpCall(second, { wait: false }), mcpCall(first, { wait: false }),
		awaitCalls(first, second), REPLY,
	]);
	const streamFunction = createGeminiCliStreamFunction(runGemini);
	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.deepEqual(getToolCalls(toolMessage).map((call) => call.id).sort(), ["t_x", "t_y"]);
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(first, "result x"), toToolResult(second, "result y")]);
	assert.equal(getText(reply), "result x | result y", "each result went back to the request of its own call");
});

test("two calls with the same name and arguments pair in arrival order", async (t) => {
	const first: ToolUse = { id: "t_d1", name: "read", arguments: { path: "same" } };
	const second: ToolUse = { id: "t_d2", name: "read", arguments: { path: "same" } };
	const { runGemini } = createFakeRun(t, [
		INIT, CONNECT, toolUse(first), toolUse(second),
		mcpCall(first, { wait: false }), mcpCall(second, { wait: false }),
		awaitCalls(first, second), REPLY,
	]);
	const streamFunction = createGeminiCliStreamFunction(runGemini);
	const toolMessage = await runTurn(streamFunction, [HI]);
	assert.deepEqual(getToolCalls(toolMessage).map((call) => call.id), ["t_d1", "t_d2"]);
	const reply = await runTurn(streamFunction, [HI, toolMessage, toToolResult(first, "one"), toToolResult(second, "two")]);
	assert.equal(getText(reply), "one | two");
});

test("an MCP request with no matching tool_use fails the turn", async (t) => {
	const stray: ToolUse = { id: "t_stray", name: "read", arguments: { path: "stray" } };
	const other: ToolUse = { id: "t_other", name: "read", arguments: { path: "other" } };
	const { runGemini, calls } = createFakeRun(t, [INIT, toolUse(other), mcpCall(stray, { wait: false }), HOLD]);
	const events = await collectEvents(createGeminiCliStreamFunction(runGemini)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));
	assert.match(getErrorMessage(events) ?? "", /does not match its streamed tool intent/);
	await waitForExit(getOnlyCall(calls).child);
});

const IMAGE: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
const IMAGE_ERROR = "Gemini CLI provider cannot read images. Remove the image or switch the model.";

test("an image in the newest learner message stops the turn before any child starts", async (t) => {
	const { runGemini, calls } = createFakeRun(t, [INIT, SUCCESS]);
	const message: Message = { role: "user", content: [{ type: "text", text: "what is this?" }, IMAGE], timestamp: 0 };
	const events = await collectEvents(createGeminiCliStreamFunction(runGemini)(getModel(), getContext([message]), { sessionId: SESSION_ID }));
	assert.equal(getErrorMessage(events), IMAGE_ERROR);
	assert.equal(calls.length, 0, "the fake gemini is never started");
});

test("an image in an earlier message is written as [image omitted] in the replayed prompt", async (t) => {
	const { runGemini, calls } = createFakeRun(t, [INIT, assistant("ok"), SUCCESS, HOLD]);
	const earlier: Message = { role: "user", content: [{ type: "text", text: "look" }, IMAGE], timestamp: 0 };
	const answer: Message = {
		role: "assistant", content: [{ type: "text", text: "a cat" }], api: "x", provider: "x", model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 0,
	};
	const next: Message = { role: "user", content: "and now?", timestamp: 0 };
	await runTurn(createGeminiCliStreamFunction(runGemini), [earlier, answer, next]);
	const { stdin } = readRecord(getOnlyCall(calls));
	assert.match(stdin, /\[image omitted\]/);
	assert.match(stdin, /look/);
	assert.match(stdin, /and now\?/);
	await waitForExit(getOnlyCall(calls).child);
});

const WIN_LOOKUP_BASE = { platform: "win32", homeDir: "C:\\Users\\u", cwd: "C:\\", env: { PATH: "C:\\npm;C:\\nodejs", APPDATA: "C:\\Users\\u\\AppData\\Roaming" } } as const;
const WIN_SHIM = "C:\\npm\\gemini.cmd";
const WIN_BUNDLE = "C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js";
const WIN_NODE = "C:\\nodejs\\node.exe";

function winLookup(files: string[]) {
	const exists = (path: string) => files.includes(path);
	return { ...WIN_LOOKUP_BASE, isExecutable: exists, isFile: exists };
}

test("on Windows gemini.cmd with its bundle resolves to node running gemini.js; the shim itself is never started", () => {
	assert.deepEqual(resolveGeminiInstall(winLookup([WIN_SHIM, WIN_BUNDLE, WIN_NODE])), { kind: GeminiInstallKind.BUNDLE, script: WIN_BUNDLE, node: WIN_NODE });
});

test("on Windows a gemini.cmd without its bundle is not found", () => {
	assert.deepEqual(resolveGeminiInstall(winLookup([WIN_SHIM, WIN_NODE])), { kind: GeminiInstallKind.NOT_FOUND });
});

test("on Windows a bundle without node on PATH is reported as node-missing", () => {
	assert.deepEqual(resolveGeminiInstall(winLookup([WIN_SHIM, WIN_BUNDLE])), { kind: GeminiInstallKind.NODE_MISSING, script: WIN_BUNDLE });
});

test("off Windows the plain gemini binary is found as before and a .cmd is not looked for", () => {
	const lookup = { platform: "linux", homeDir: "/home/u", cwd: "/", env: { PATH: "/usr/bin" }, isFile: () => true, isExecutable: (path: string) => path === "/usr/bin/gemini" } as const;
	assert.deepEqual(resolveGeminiInstall(lookup), { kind: GeminiInstallKind.BINARY, binary: "/usr/bin/gemini" });
	assert.deepEqual(resolveGeminiInstall({ ...lookup, isExecutable: () => false }), { kind: GeminiInstallKind.NOT_FOUND });
});

test("a bundle script is started by node for the version check and for the turn, and a missing node stops with its own error", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gemini-bundle-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "gemini.js");
	writeFileSync(script, `process.stdout.write(process.argv[2] === "--version" ? "${GEMINI_CLI_MINIMUM_VERSION}\\n" : "not a version\\n");\n`);
	const { runGemini, calls } = createFakeRun(t, [INIT, assistant("hi"), SUCCESS, HOLD]);
	const started: { file: string; args: string[] }[] = [];
	const launcher = createGeminiLauncher({
		findBinary: () => script,
		findNode: () => process.execPath,
		spawnProcess: ((file: string, args: string[], options: object) => {
			started.push({ file, args });
			return runGemini(args.slice(1), options as never);
		}) as typeof spawn,
	});
	const events = await collectEvents(createGeminiCliStreamFunction(launcher)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));
	assert.equal(getLastEvent(events).type, "done");
	assert.equal(started.length, 1);
	assert.equal(started[0]?.file, process.execPath);
	assert.equal(started[0]?.args[0], script);
	assert.ok(started[0]?.args.includes("stream-json"));
	await waitForExit(getOnlyCall(calls).child);

	const noNode = createGeminiLauncher({ findBinary: () => script, findNode: () => null, spawnProcess: (() => { throw new Error("must not start"); }) as typeof spawn });
	const failed = await collectEvents(createGeminiCliStreamFunction(noNode)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));
	assert.equal(getErrorMessage(failed), NODE_MISSING_MESSAGE);
	assert.equal(NODE_MISSING_MESSAGE, "Gemini CLI was found but Node.js was not found on PATH.");
});

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Every process the fake recorded is gone, within the cleanup timeout. */
async function assertPidsGone(pidFile: string): Promise<number[]> {
	const pids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
	assert.ok(pids.length > 0, "the fake recorded its pid");
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS * 2;
	while (pids.some(isAlive)) {
		assert.ok(Date.now() < deadline, `processes of the CLI are still alive: ${pids.filter(isAlive).join(", ")}`);
		await sleep(20);
	}
	return pids;
}

test("the turn's env tells the bundle not to start a copy of itself, and an abort leaves no process of the chain alive", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gemini-pids-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pidFile = join(dir, "pids.txt");
	const { runGemini, calls } = createFakeRun(t, [INIT, assistant("partial"), HOLD], { FAKE_GEMINI_PIDS: pidFile });
	t.after(() => { for (const pid of existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
	const controller = new AbortController();
	const events = await collectEvents(
		createGeminiCliStreamFunction(runGemini)(getModel(), getContext([HI]), { sessionId: SESSION_ID, signal: controller.signal }),
		(event) => { if (event.type === "text_delta") controller.abort(); },
	);
	assert.equal(getLastEvent(events).type, "error");
	const call = getOnlyCall(calls);
	assert.equal(call.env.GEMINI_CLI_NO_RELAUNCH, "1");
	await assertCleanedUp(call);
	assert.equal((await assertPidsGone(pidFile)).length, 1, "with the variable set the fake does the work itself");
});

test("--version is read with GEMINI_CLI_NO_RELAUNCH=1 too, so a bundle that relaunches itself is not started twice", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gemini-version-env-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "gemini.js");
	writeFileSync(script, `import(${JSON.stringify(pathToFileURL(FAKE_GEMINI).href)});\n`);
	const versionRecord = join(dir, "version-env.json");
	const saved = process.env.FAKE_GEMINI_VERSION_ENV_RECORD;
	process.env.FAKE_GEMINI_VERSION_ENV_RECORD = versionRecord;
	t.after(() => { if (saved === undefined) delete process.env.FAKE_GEMINI_VERSION_ENV_RECORD; else process.env.FAKE_GEMINI_VERSION_ENV_RECORD = saved; });

	const { runGemini, calls } = createFakeRun(t, [INIT, assistant("hi"), SUCCESS, HOLD]);
	const launcher = createGeminiLauncher({
		findBinary: () => script,
		findNode: () => process.execPath,
		spawnProcess: ((_file: string, args: string[], options: object) => runGemini(args.slice(1), options as never)) as typeof spawn,
	});
	const events = await collectEvents(createGeminiCliStreamFunction(launcher)(getModel(), getContext([HI]), { sessionId: SESSION_ID }));
	assert.equal(getLastEvent(events).type, "done");
	assert.deepEqual(JSON.parse(readFileSync(versionRecord, "utf8")), { noRelaunch: "1" });
	assert.equal(getOnlyCall(calls).env.GEMINI_CLI_NO_RELAUNCH, "1");
	await waitForExit(getOnlyCall(calls).child);
});

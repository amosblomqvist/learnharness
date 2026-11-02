/**
 * Claude Code provider driven through the real chat handler: a learner-facing
 * question ends the turn while the CLI process waits on the held MCP call, and
 * the learner's answer arrives later as that call's tool result.
 *
 * The runClaude seam spawns tests/fixtures/claude-code/fake-claude.mjs, one
 * scenario per spawn, so the spawn count shows whether the answer continued
 * the waiting process or started a fresh one with a replay.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";

import type { RunClaude } from "../src/agent/claude-code/stream.ts";
import type { PiEngine } from "../src/agent/models.ts";

// Opt-in writes must not race another test process's settings record.
const testData = mkdtempSync(join(tmpdir(), "lh-cli-harness-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { LIVE_PROCESS_IDLE_TIMEOUT_MS, liveProcessIdleTimeoutMs } = await import("../src/agent/claude-code/live-processes.ts");
const { CLAUDE_CODE_MODELS } = await import("../src/agent/claude-code/provider.ts");
const { createClaudeCodeStreamFunction } = await import("../src/agent/claude-code/stream.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { cliContextWindowOf, danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const TEXT_FIXTURE = fileURLToPath(new URL("./fixtures/claude-code/text.jsonl", import.meta.url));
const TURN_TIMEOUT_MS = 8000;

const ASK_ID = "toolu_harness_ask";
const ASK_INPUT = { question: "What do you already know about sockets?" };
const ANSWER_TEXT = "Only that they carry bytes between programs";

type FakeRun = { runClaude: RunClaude; children: ChildProcessWithoutNullStreams[]; stdinFiles: string[] };

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function toAskScenario(): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: ASK_ID, name: "mcp__learnharness__ask_user_question", input: {} },
		}),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(ASK_INPUT) } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		JSON.stringify({ fake: "call", id: ASK_ID, name: "ask_user_question", arguments: ASK_INPUT }),
		JSON.stringify({ fake: "reply" }),
	];
}

function createFakeRun(t: TestContext, scenarios: string[][]): FakeRun {
	const settings = readSettings();
	writeSettings({ ...(settings ?? { version: 1 }), claudeCode: { enabled: true } });
	t.after(() => { if (settings) writeSettings(settings); else rmSync(SETTINGS_FILE, { force: true }); });
	const dir = mkdtempSync(join(tmpdir(), "claude-code-harness-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Satisfy the real presence gate; this marker is NEVER executed. All work
	// below goes through the injected Node fake-CLI seam, not an installed CLI.
	writeFileSync(join(dir, process.platform === "win32" ? "claude.exe" : "claude"), "", { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; });

	const children: ChildProcessWithoutNullStreams[] = [];
	const stdinFiles: string[] = [];

	const runClaude: RunClaude = (args, options) => {
		const scenario = scenarios[children.length];
		assert.ok(scenario, `unexpected spawn #${children.length + 1}`);

		const scenarioFile = join(dir, `scenario-${children.length}.jsonl`);
		const stdinFile = join(dir, `stdin-${children.length}.jsonl`);
		writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile, FAKE_CLAUDE_STDIN: stdinFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));

		children.push(child);
		stdinFiles.push(stdinFile);
		return child;
	};

	return { runClaude, children, stdinFiles };
}

function createClaudeCodeChat(t: TestContext): string {
	const chat = chatStore.createChat("Claude Code: question answered later");
	chatStore.saveSettings(chat.id, { model: { provider: "claude-code", id: "sonnet" } });
	t.after(() => unlinkSync(join(PATHS.chats, `${chat.id}.json`)));

	return chat.id;
}

function createAgentFactory(fakeRun: FakeRun): Parameters<typeof handleChatRequest>[1] {
	const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "sonnet");
	assert.ok(model);

	const engine: PiEngine = { model, streamFn: createClaudeCodeStreamFunction(fakeRun.runClaude) };

	return (options) => createTeacherAgent(undefined, { engine, chatId: options.chatId, messages: options.messages });
}

async function runChatTurn(chatId: string, input: object, agentFactory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const request = new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});

	const ack = await handleChatRequest(request, agentFactory);
	assert.equal(ack.status, 200, await ack.clone().text());

	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();

	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (isTurnRunning(chatId)) {
		assert.ok(Date.now() < deadline, "turn did not settle");
		await sleep(10);
	}
}

function toAnswerInput(): object {
	return {
		type: "answer",
		toolCallId: ASK_ID,
		answer: { kind: "ask", questionText: ASK_INPUT.question, dontKnow: false, answers: [], text: ANSWER_TEXT, answeredAt: new Date().toISOString() },
	};
}

function getLastAssistantText(chatId: string): string {
	const messages = chatStore.getChat(chatId)?.messages ?? [];
	const assistant = messages.findLast((message) => message.role === "assistant");
	assert.ok(assistant?.role === "assistant");

	return assistant.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;

	await once(child, "exit", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) });
}

test("disabled opt-in refuses a saved CLI chat before write-ahead, liveness, or agent creation", async (t) => {
	const fakeRun = createFakeRun(t, [toAskScenario()]);
	const chatId = createClaudeCodeChat(t);
	writeSettings({ ...(readSettings() ?? { version: 1 }), claudeCode: { enabled: false } });
	const before = chatStore.getChat(chatId)!.messages;
	const response = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text: "must not start" } }) }), () => assert.fail("disabled work must not build an agent"));
	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /Enable and set it up in Settings/);
	assert.equal(isTurnRunning(chatId), false); assert.equal(fakeRun.children.length, 0);
	assert.deepEqual(chatStore.getChat(chatId)!.messages, before);
	assert.deepEqual(chatStore.getChat(chatId)!.settings?.model, { provider: "claude-code", id: "sonnet" });
});

test("switching off blocks future requests but does not interrupt an already admitted CLI turn", async (t) => {
	const scenario = [JSON.stringify({ fake: "checkpoint" }), JSON.stringify({ fake: "wait-for-message" }), ...readFileSync(TEXT_FIXTURE, "utf8").trim().split("\n")];
	const fakeRun = createFakeRun(t, [scenario]);
	const run = fakeRun.runClaude;
	let ready!: (child: ChildProcessWithoutNullStreams) => void;
	let failed!: (error: unknown) => void;
	const checkpoint = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => { ready = resolve; failed = reject; });
	fakeRun.runClaude = async (args, options) => {
		const child = await run(args, options); assert(child);
		void once(child, "message", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) }).then(() => ready(child), failed);
		return child;
	};
	const chatId = createClaudeCodeChat(t);
	const response = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text: "complete this admitted fixture" } }) }), createAgentFactory(fakeRun));
	assert.equal(response.status, 200);
	const child = await checkpoint;
	const handle = runningTurn(chatId); assert(handle);
	const finished = new Response(handle.subscribe()).text();
	writeSettings({ ...(readSettings() ?? { version: 1 }), claudeCode: { enabled: false } });
	assert.equal(child.signalCode, null, "opt-out must not kill an already running process");
	child.send("continue"); await finished;
	assert(getLastAssistantText(chatId).length > 0, "the admitted turn completes normally");
	assert.equal(readSettings()?.claudeCode?.enabled, false);
	await waitForExit(child);
});

test("a question answered before the idle timeout continues the waiting CLI process with the answer", async (t) => {
	const fakeRun = createFakeRun(t, [toAskScenario()]);
	const run = fakeRun.runClaude;
	fakeRun.runClaude = (args, options) => run(args, { ...options, env: { ...options.env, FAKE_CLAUDE_WINDOW: "200000" } });
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createClaudeCodeChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);

	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	assert.equal(waiting.exitCode, null, "the CLI process should wait on the held question call");

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 1);
	assert.deepEqual(cliContextWindowOf(chatStore.getChat(chatId)!.messages), { model: "claude-code:sonnet", tokens: 200000 });
	assert.deepEqual(cliContextWindowOf(JSON.parse(readFileSync(join(PATHS.chats, `${chatId}.json`), "utf8")).messages), { model: "claude-code:sonnet", tokens: 200000 });
	assert.ok(getLastAssistantText(chatId).includes(ANSWER_TEXT), getLastAssistantText(chatId));
	await waitForExit(waiting);
});

test("a question pauses later calls from the same CLI response until the learner answers", async (t) => {
	const secondId = "toolu_second_question";
	const secondQuestion = "What do you want to learn next?";
	const scenario = toAskScenario();
	scenario.splice(4, 0,
		streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: secondId, name: "mcp__learnharness__ask_user_question", input: {} } }),
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ question: secondQuestion }) } }),
		streamEvent({ type: "content_block_stop", index: 1 }),
	);
	scenario.splice(scenario.length - 1, 0, JSON.stringify({ fake: "call", id: secondId, name: "ask_user_question", arguments: { question: secondQuestion } }));
	const fakeRun = createFakeRun(t, [scenario]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createClaudeCodeChat(t);
	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	assert.equal(JSON.stringify(chatStore.getChat(chatId)?.messages).includes(secondId), false, "unadmitted second question must not be posed or persisted");
	await runChatTurn(chatId, toAnswerInput(), factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, secondId);
	await runChatTurn(chatId, {
		type: "answer", toolCallId: secondId,
		answer: { kind: "ask", questionText: secondQuestion, dontKnow: false, answers: [], text: "HTTP next", answeredAt: new Date().toISOString() },
	}, factory);
	assert.equal(fakeRun.children.length, 1);
	assert.ok(getLastAssistantText(chatId).includes(ANSWER_TEXT));
	assert.ok(getLastAssistantText(chatId).includes("HTTP next"));
	await waitForExit(fakeRun.children[0]!);
});

test("an individually cancelled MCP question queued behind a learner wait never executes", async (t) => {
	const cancelledId = "toolu_cancelled_question";
	const question = "This cancelled question must never be posed";
	const scenario = toAskScenario();
	scenario.splice(4, 0,
		streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: cancelledId, name: "mcp__learnharness__ask_user_question", input: {} } }),
		streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ question }) } }),
		streamEvent({ type: "content_block_stop", index: 1 }),
	);
	scenario.splice(scenario.length - 2, 2,
		JSON.stringify({ fake: "start-call", id: ASK_ID, name: "ask_user_question", arguments: ASK_INPUT }),
		JSON.stringify({ fake: "wait-for-message" }),
		JSON.stringify({ fake: "start-call", id: cancelledId, name: "ask_user_question", arguments: { question } }),
		JSON.stringify({ fake: "cancel-call", id: cancelledId }),
		JSON.stringify({ fake: "checkpoint" }),
		JSON.stringify({ fake: "reply" }),
	);
	const fakeRun = createFakeRun(t, [scenario]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createClaudeCodeChat(t);
	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	const child = fakeRun.children[0]!;
	const cancelledOnServer = once(child, "message", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) });
	child.send("queue and cancel B");
	assert.deepEqual((await cancelledOnServer)[0], { fake: "checkpoint" });
	await runChatTurn(chatId, toAnswerInput(), factory);
	assert.equal(fakeRun.children.length, 1);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? []), null);
	assert.equal(JSON.stringify(chatStore.getChat(chatId)?.messages).includes(cancelledId), false, "cancelled B must never reach native tool execution or persistence");
	assert.ok(getLastAssistantText(chatId).includes(ANSWER_TEXT));
	await waitForExit(child);
});

test("a question answered after the idle timeout starts a fresh CLI process that replays the question and answer", async (t) => {
	liveProcessIdleTimeoutMs.current = 300;
	t.after(() => (liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS));

	const fakeRun = createFakeRun(t, [toAskScenario(), readFileSync(TEXT_FIXTURE, "utf8").split("\n").filter(Boolean)]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createClaudeCodeChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);

	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	assert.equal(waiting.exitCode, null, "the CLI process should wait on the held question call");
	await waitForExit(waiting);

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 2);
	assert.equal(getLastAssistantText(chatId), "hello there");

	const replay = readFileSync(fakeRun.stdinFiles[1] ?? "", "utf8");
	assert.ok(replay.includes("[tool call ask_user_question]"), replay);
	assert.ok(replay.includes(ASK_INPUT.question), replay);
	assert.ok(replay.includes("[tool result ask_user_question]"), replay);
	assert.ok(replay.includes(ANSWER_TEXT), replay);
});

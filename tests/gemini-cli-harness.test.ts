/**
 * Gemini provider driven through the real chat handler: a learner-facing
 * question ends the turn while the Gemini CLI process waits on a held HTTP
 * MCP tool call. The learner's answer completes that call on the same child
 * process, which emits stream-json events.
 *
 * The runGemini seam spawns tests/fixtures/gemini-cli/fake-gemini.mjs so the spawn
 * count shows whether the answer continued the waiting process or started a
 * fresh one.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";

import type { RunGemini } from "../src/agent/gemini-cli/stream.ts";
import type { PiEngine } from "../src/agent/models.ts";

// Opt-in writes must not race another test process's settings record.
const testData = mkdtempSync(join(tmpdir(), "lh-gemini-harness-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { createGeminiCliStreamFunction } = await import("../src/agent/gemini-cli/stream.ts");
const { piModels } = await import("../src/agent/models.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { EXTERNAL_CLI_PROVIDERS } = await import("../src/core/contracts/external-cli.ts");
const { danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { PROVIDER_KEY_MISSING_CODE } = await import("../src/core/settings.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { abortTurn, runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

const FAKE_GEMINI = fileURLToPath(new URL("./fixtures/gemini-cli/fake-gemini.mjs", import.meta.url));
const TURN_TIMEOUT_MS = 8000;
const CLEANUP_TIMEOUT_MS = 2000;

const THREAD_ID = "thr_1";
const TURN_ID = "turn_1";
const ASK_ID = "call_harness_ask";
const ASK_INPUT = { question: "What do you already know about sockets?" };
const ANSWER_TEXT = "Only that they carry bytes between programs";

const GEMINI_MODEL_ENTRY = { id: "pro" };

const HOLD = JSON.stringify({ fake: "hold" });

type RunRecord = {
	child: ChildProcessWithoutNullStreams;
	cwd: string;
};

type FakeRun = {
	runGemini: RunGemini;
	calls: RunRecord[];
};

function toAskScenario(): string[] {
	return [
		JSON.stringify({ fake: "call", id: ASK_ID, name: "ask_user_question", arguments: ASK_INPUT }),
		JSON.stringify({ fake: "reply" }),
	];
}

async function createFakeRun(t: TestContext, scenarios: string[][]): Promise<FakeRun> {

	const settings = readSettings();
	writeSettings({ ...(settings ?? { version: 1 }), geminiCli: { enabled: true } });
	t.after(() => { if (settings) writeSettings(settings); else rmSync(SETTINGS_FILE, { force: true }); });

	const dir = mkdtempSync(join(tmpdir(), "gemini-harness-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Satisfy the real presence gate; this marker is NEVER executed.
	writeFileSync(join(dir, process.platform === "win32" ? "gemini.exe" : "gemini"), "", { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; });

	const calls: RunRecord[] = [];
	const runGemini: RunGemini = (args, options) => {
		const scenario = scenarios[calls.length];
		assert.ok(scenario, `unexpected spawn #${calls.length + 1}`);

		const scenarioFile = join(dir, `scenario-${calls.length}.jsonl`);
		writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

		const child = spawn(process.execPath, [FAKE_GEMINI, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_GEMINI_SCENARIO: scenarioFile },
			stdio: "pipe",
		});
		t.after(() => child.kill("SIGKILL"));

		calls.push({ child, cwd: options.cwd });
		return child;
	};

	return { runGemini, calls };
}

function createGeminiChat(t: TestContext): string {
	const chat = chatStore.createChat("Gemini: lesson turn");
	chatStore.saveSettings(chat.id, { model: { provider: EXTERNAL_CLI_PROVIDERS.geminiCli, id: GEMINI_MODEL_ENTRY.id } });
	t.after(() => unlinkSync(join(PATHS.chats, `${chat.id}.json`)));
	return chat.id;
}

function createAgentFactory(fakeRun: FakeRun): Parameters<typeof handleChatRequest>[1] {
	const model = piModels().getModel(EXTERNAL_CLI_PROVIDERS.geminiCli, GEMINI_MODEL_ENTRY.id);
	assert.ok(model);

	const engine: PiEngine = { model, streamFn: createGeminiCliStreamFunction(fakeRun.runGemini) };
	return (options) => createTeacherAgent(undefined, { engine, chatId: options.chatId, messages: options.messages });
}

function postChatRequest(chatId: string, input: object, agentFactory: Parameters<typeof handleChatRequest>[1]): Promise<Response> {
	return handleChatRequest(new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	}), agentFactory);
}

async function waitForTurnSettled(chatId: string): Promise<void> {
	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (isTurnRunning(chatId)) {
		assert.ok(Date.now() < deadline, "turn did not settle");
		await sleep(10);
	}
}

async function runChatTurn(chatId: string, input: object, agentFactory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const ack = await postChatRequest(chatId, input, agentFactory);
	assert.equal(ack.status, 200, await ack.clone().text());

	const handle = runningTurn(chatId);
	const wireText = handle ? await new Response(handle.subscribe()).text() : "";
	await waitForTurnSettled(chatId);
	return wireText;
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

function parseWireEvents(sseText: string): Array<Record<string, any>> {
	return sseText
		.split(/\r?\n\r?\n/)
		.flatMap((frame) => {
			const line = frame.split(/\r?\n/).find((entry) => entry.startsWith("data: "));
			if (!line) return [];
			const payload = line.slice("data: ".length).trim();
			if (!payload || payload === "[DONE]") return [];
			return [JSON.parse(payload) as Record<string, any>];
		});
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

async function assertCleanedUp(call: RunRecord): Promise<void> {
	await waitForExit(call.child);
	await waitForRemoval(call.cwd);
}

test("a question answered on Gemini continues the same waiting child process with the answer", async (t) => {
	const fakeRun = await createFakeRun(t, [toAskScenario()]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createGeminiChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);

	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	assert.equal(fakeRun.calls.length, 1);
	const [waiting] = fakeRun.calls;
	assert.ok(waiting);
	assert.equal(waiting.child.exitCode, null, "the Gemini process should wait on the held dynamic tool call");

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.calls.length, 1);
	assert.ok(getLastAssistantText(chatId).includes(ANSWER_TEXT), getLastAssistantText(chatId));
	await assertCleanedUp(waiting);
});

test("disabled opt-in refuses a saved Gemini chat with 503 providerKeyMissing before spawning", async (t) => {
	const fakeRun = await createFakeRun(t, [toAskScenario()]);
	const chatId = createGeminiChat(t);
	writeSettings({ ...(readSettings() ?? { version: 1 }), geminiCli: { enabled: false } });
	const before = chatStore.getChat(chatId)!.messages;

	const response = await postChatRequest(
		chatId,
		{ type: "text", text: "must not start" },
		() => assert.fail("disabled work must not build an agent"),
	);

	assert.equal(response.status, 503);
	const body = await response.json() as { code?: string; provider?: string; error?: string };
	assert.equal(body.code, PROVIDER_KEY_MISSING_CODE);
	assert.equal(body.provider, EXTERNAL_CLI_PROVIDERS.geminiCli);
	assert.match(body.error ?? "", /Enable and set it up in Settings/);
	assert.equal(isTurnRunning(chatId), false);
	assert.equal(fakeRun.calls.length, 0);
	assert.deepEqual(chatStore.getChat(chatId)!.messages, before);
});

test("aborting a running Gemini turn stops the child process and removes the temp dir", async (t) => {
	const fakeRun = await createFakeRun(t, [[JSON.stringify({ type: "message", role: "assistant", content: "partial", delta: true }), HOLD]]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createGeminiChat(t);

	const ack = await postChatRequest(chatId, { type: "text", text: "abort this turn" }, agentFactory);
	assert.equal(ack.status, 200, await ack.clone().text());

	const handle = runningTurn(chatId);
	assert.ok(handle);
	const reader = handle.subscribe().getReader();
	const decoder = new TextDecoder();
	let aborted = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		if (!aborted && (chunk.includes('"message_update"') || chunk.includes('"message_start"'))) {
			aborted = true;
			assert.deepEqual(abortTurn(chatId), { ok: true });
		}
	}
	assert.equal(aborted, true, "turn never emitted start/update before stream closed");

	await waitForTurnSettled(chatId);
	assert.equal(fakeRun.calls.length, 1);
	const [call] = fakeRun.calls;
	assert.ok(call);
	await assertCleanedUp(call);
});

test("a built-in tool item fails the turn, reports the error on the turn subscription, and leaves no child process", async (t) => {
	const fakeRun = await createFakeRun(t, [[
		JSON.stringify({ type: "message", role: "assistant", content: "x", delta: true }),
		JSON.stringify({ fake: "tool-use", id: "cmd_1", tool_name: "web_fetch", parameters: {} }),
		HOLD,
	]]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createGeminiChat(t);

	const wireText = await runChatTurn(chatId, { type: "text", text: "trigger built-in tool" }, agentFactory);

	const events = parseWireEvents(wireText);
	const errorMessageEvent = events.find(
		(event) => event.type === "message_end" && event.message?.role === "assistant" && event.message?.stopReason === "error",
	);
	assert.ok(errorMessageEvent, `expected error message_end event on runningTurn subscription, got: ${wireText}`);
	assert.match(errorMessageEvent.message.errorMessage ?? "", /unsupported native tool call/);

	assert.equal(fakeRun.calls.length, 1);
	const [call] = fakeRun.calls;
	assert.ok(call);
	await assertCleanedUp(call);
});

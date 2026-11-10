import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test, type TestContext } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { PluginBackendContext } from "../src/core/plugins.ts";
import type { JsonValue } from "../src/core/plugin-questions.ts";
import type { PluginProblemProcessingContext } from "../src/core/plugin-problems.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-problem-flow-"));
process.env.LH_DATA_DIR = path.join(root, "data"); process.env.LH_AUTH_FILE = path.join(root, "auth.json"); process.env.OPENROUTER_API_KEY = "isolated-presence-only";
const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw Error("Unexpected external network"); };
const dist = path.join(root, "data", "plugins", "problem-fixture", "dist"); fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "problem-fixture", name: "Fixture", version: "1.0.0", minAppVersion: "0.4.1", backend: "backend.cjs" }));
fs.writeFileSync(path.join(dist, "backend.cjs"), "exports.activate = ctx => ctx.handle('context', () => ctx);");
const { getPluginHost } = await import("../src/server/plugins.ts"), { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createPracticeAgent } = await import("../src/agent/teacher-agent.ts"), { chatStore } = await import("../src/store/chats.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts"), { runningTurn, abortTurn } = await import("../src/server/turn-runs.ts");
const { activeProblemOf, modelSolutionForConclude, newUserMessage } = await import("../src/core/native-messages.ts");
const host = await getPluginHost(); await host.setEnabled("problem-fixture", true);
const ctx = await host.call("problem-fixture", "context") as PluginBackendContext;
after(async () => { await host.dispose(); globalThis.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
let serial = 0;
async function fixture(t: TestContext, processSubmission: (context: PluginProblemProcessingContext<object, string>) => JsonValue | Promise<JsonValue>, conclude = false) {
  const id = `code${++serial}`, toolName = `problem_${id}`;
  const off = ctx.registerProblemType({ id, label: "Code", contractVersion: 1, tool: { toolName, description: "Pose code" }, problemSchema: Type.Object({}), submissionSchema: Type.String({ minLength: 1 }), processSubmission }); t.after(off);
  const chat = chatStore.createChat("Isolated plugin problem", "practice");
  chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
  const input = { statement: "Implement f", mode: "composition", modelSolution: "The committed solution", payload: {} };
  const occurrence = { messageId: `${id}-pose`, contentIndex: 0, toolCallId: `${id}-call`, toolName };
  const snapshot = { protocolVersion: 1, problemId: `${id}-problem`, pluginId: "problem-fixture", typeId: id, label: "Code", contractVersion: 1,
    input, problemSchema: { type: "object", properties: {} }, submissionSchema: { type: "string", minLength: 1 }, requiresSubmissionRefinement: false, requiresProcessing: true };
  chatStore.saveMessages(chat.id, [newUserMessage("Start"), { ...fauxAssistantMessage([fauxToolCall(toolName, input, { id: occurrence.toolCallId })], { stopReason: "toolUse" }), id: occurrence.messageId },
    { id: `${id}-ack`, role: "toolResult", toolCallId: occurrence.toolCallId, toolName, content: [{ type: "text", text: "Problem posed" }], details: { pluginProblem: snapshot }, isError: false, timestamp: Date.now() }] as LhMessage[]);
  let factories = 0, modelInput = "";
  const faux = createFauxCore({});
  faux.setResponses([context => {
    modelInput = JSON.stringify(context.messages);
    return conclude ? fauxAssistantMessage([fauxToolCall("conclude", { outcome: "solved", verdict: "Correct", rung: null, missClass: null, retest: false }, { id: `${id}-conclude` })], { stopReason: "toolUse" }) : fauxAssistantMessage("Continue working on this problem.");
  }]);
  const factory: NonNullable<Parameters<typeof handleChatRequest>[1]> = options => { factories++; return createPracticeAgent({ chatId: chat.id, chatStore }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, messages: options.messages }); };
  const submission = { type: "plugin-problem-submission", problemId: snapshot.problemId, occurrence, submission: "code", thinking: "reasoning" };
  const saved = () => chatStore.getChat(chat.id)!;
  const submissions = () => saved().messages.filter(message => message.role === "custom" && message.customType === "plugin-problem-submission");
  const post = (value: unknown = "code") => handleChatRequest(new Request("http://fixture/api/chat", { method: "POST", body: JSON.stringify({ chatId: chat.id, input: { ...submission, submission: value } }) }), factory);
  const settle = async (response: Response) => { assert.equal(response.status, 200, await response.clone().text()); const turn = runningTurn(chat.id); if (turn) await new Response(turn.subscribe()).text(); };
  const wait = async (started: Promise<unknown>, response: Promise<Response>) => { await Promise.race([started, response.then(value => { throw Error(`Processing never started: ${value.status}`); })]); };
  return { chat, saved, submissions, post, settle, wait, off, factories: () => factories, modelInput: () => modelInput, concludeId: `${id}-conclude` };
}

test("practice processing owns the turn, rejects concurrent processing and saves observations before one continuation", { timeout: 10000 }, async t => {
  const started = deferred<void>(), release = deferred<JsonValue>(); let calls = 0; t.after(() => release.resolve(false));
  const f = await fixture(t, async context => { calls++; assert.equal(context.thinking, "reasoning"); started.resolve(); return release.promise; });
  const response = f.post(); await f.wait(started.promise, response);
  assert.equal(isTurnRunning(f.chat.id), true); assert.ok(runningTurn(f.chat.id)); assert.equal(f.submissions().length, 0); assert.equal(f.factories(), 0);
  assert.equal((await f.post()).status, 409); assert.equal(calls, 1);
  release.resolve(false); await f.settle(await response);
  const marker = f.submissions()[0]!; assert.equal(marker.role, "custom"); if (marker.role !== "custom") return;
  assert.deepEqual((marker.details as { processing: unknown }).processing, { result: false });
  assert.equal(f.factories(), 1); assert.match(f.modelInput(), /processing/); assert.ok(activeProblemOf(f.saved().messages)); assert.equal(isTurnRunning(f.chat.id), false);
  await f.settle(await f.post()); assert.equal(calls, 2); assert.equal(f.submissions().length, 2);
});

test("only the existing conclude tool assesses and closes a processed plugin problem", { timeout: 10000 }, async t => {
  const f = await fixture(t, () => ({ passed: true }), true);
  await f.settle(await f.post());
  assert.equal(f.submissions().length, 1); assert.equal(activeProblemOf(f.saved().messages), null);
  assert.equal(modelSolutionForConclude(f.saved().messages, f.concludeId), "The committed solution");
});

test("Stop and unregister cancel processing without saving a late submission", { timeout: 10000 }, async t => {
  for (const mode of ["stop", "unregister"] as const) {
    const started = deferred<void>(), release = deferred<JsonValue>(); let signal!: AbortSignal; t.after(() => release.resolve(true));
    const f = await fixture(t, async context => { signal = context.signal; started.resolve(); return release.promise; });
    const response = f.post(); await f.wait(started.promise, response);
    if (mode === "stop") assert.deepEqual(abortTurn(f.chat.id), { ok: true }); else f.off();
    assert.equal(signal.aborted, true); assert.equal(isTurnRunning(f.chat.id), true); assert.equal((await f.post()).status, 409);
    release.resolve(true); assert.notEqual((await response).status, 200);
    assert.equal(f.submissions().length, 0); assert.equal(f.factories(), 0); assert.ok(activeProblemOf(f.saved().messages)); assert.equal(isTurnRunning(f.chat.id), false);
  }
});

test("invalid submissions never process; ordinary processing failure remains accepted observation", { timeout: 10000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; throw Error("Tests failed to launch"); });
  assert.equal((await f.post("")).status, 400); assert.equal(calls, 0); assert.equal(f.submissions().length, 0);
  await f.settle(await f.post()); assert.equal(calls, 1);
  assert.deepEqual((f.submissions()[0] as { details: { processing: unknown } }).details.processing, { error: "Tests failed to launch" });
});

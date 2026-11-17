import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { activate } from "../plugins/coding-questions/src/backend.ts";
import { readTestResult } from "../plugins/coding-questions/src/test-result.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coding-practice-flow-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.OPENROUTER_API_KEY = "isolated-presence-only";
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected external network"); };
// Exercise the same public backend API as a distinct community fixture; the
// production core ID is reserved and must not load code from a data directory.
const pluginId = "coding-questions-fixture";
const dist = path.join(root, "data", "plugins", pluginId, "dist");
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ apiVersion: 1, id: pluginId, name: "Coding questions", version: "0.1.0", minAppVersion: "0.4.1", backend: "backend.cjs" }));
fs.writeFileSync(path.join(dist, "backend.cjs"), "exports.activate = ctx => ctx.handle('context', () => ctx);");
const { getPluginHost } = await import("../src/server/plugins.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { pluginProblemTools } = await import("../src/agent/plugin-problem-tools.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { activeProblemOf, modelSolutionForConclude, newUserMessage } = await import("../src/core/native-messages.ts");
const { readPluginProblemSnapshot, readPluginProblemSubmission } = await import("../src/core/plugin-problems.ts");
const host = await getPluginHost();
await host.setEnabled(pluginId, true);
// This test crosses the real dynamic plugin boundary. Use the consumer's SDK
// context type rather than equating two installations of TypeBox's generic types.
const ctx = await host.call(pluginId, "context") as Parameters<typeof activate>[0];
const unregister = activate(ctx);
after(async () => { unregister(); await host.dispose(); globalThis.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });

test("real coding registration poses once, processes revisions before continuation, and reveals only through native conclude", { timeout: 15000 }, async () => {
  const chat = chatStore.createChat("Isolated coding practice", "practice");
  chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
  const practice = host.agentContributions({ chatId: chat.id, agent: "practice" }, ["problem", "conclude"]);
  const teacher = host.agentContributions({ chatId: chat.id, agent: "teacher" }, []);
  const prober = host.agentContributions({ chatId: chat.id, agent: "prober" }, []);
  assert.equal(practice.problemTypes?.length, 1);
  assert.equal(practice.questionTypes, undefined);
  assert.equal(teacher.questionTypes?.length, 1);
  assert.equal(teacher.problemTypes, undefined);
  assert.equal(prober.questionTypes, undefined);
  assert.equal(prober.problemTypes, undefined);
  assert.equal(host.list().find(plugin => plugin.id === pluginId)!.error, undefined, "Question and problem can share local type ID code without a tool collision");
  const tool = pluginProblemTools(practice.problemTypes!, chat.id, { problemActive: false })[0]!;
  assert.equal(tool.name, "coding_problem");
  const input = {
    statement: "Implement **square**.", mode: "composition",
    modelSolution: "```js\nfunction square(x) { return x * x; }\n```\n\nCOMMITTED_SOLUTION",
    payload: { language: "JavaScript", starterCode: "function square(x) {}", tests: {
      program: process.execPath, args: ["-"], code: "const fs=require('node:fs'),vm=require('node:vm'),scope={};vm.runInNewContext(fs.readFileSync('answer.txt','utf8'),scope);if(scope.square(3)!==9){console.error('Expected 9');process.exitCode=1;}else console.log('Observed test passed');",
    } },
  };
  const posed = await tool.execute("coding-pose", input);
  assert.notEqual(posed.isError, true);
  const snapshot = readPluginProblemSnapshot((posed.details as { pluginProblem: unknown }).pluginProblem)!;
  assert.ok(snapshot);
  assert.equal(snapshot.requiresProcessing, true);
  assert.equal(snapshot.input.modelSolution, input.modelSolution);
  assert.equal("modelSolution" in (snapshot.input.payload as object), false);
  const occurrence = { messageId: "coding-pose-message", contentIndex: 0, toolCallId: "coding-pose", toolName: "coding_problem" };
  chatStore.saveMessages(chat.id, [newUserMessage("Start"),
    { ...fauxAssistantMessage([fauxToolCall("coding_problem", input, { id: occurrence.toolCallId })], { stopReason: "toolUse" }), id: occurrence.messageId },
    { id: "coding-ack", role: "toolResult", toolCallId: occurrence.toolCallId, toolName: occurrence.toolName, ...posed, isError: false, timestamp: Date.now() },
  ] as LhMessage[]);
  let factories = 0;
  const modelInputs: string[] = [];
  const faux = createFauxCore({});
  faux.setResponses([context => { modelInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Revise your implementation."); },
    context => { modelInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Review another case before concluding."); },
    context => { modelInputs.push(JSON.stringify(context.messages)); return fauxAssistantMessage([fauxToolCall("conclude", { outcome: "solved", verdict: "Reviewed the code and reasoning", rung: null, missClass: null, retest: false }, { id: "coding-conclude" })], { stopReason: "toolUse" }); },
  ]);
  const factory: NonNullable<Parameters<typeof handleChatRequest>[1]> = options => {
    factories++; return createPracticeAgent({ chatId: chat.id, chatStore }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, messages: options.messages });
  };
  const saved = () => chatStore.getChat(chat.id)!;
  const submissions = () => saved().messages.flatMap(message => message.role === "custom" && message.customType === "plugin-problem-submission" ? [readPluginProblemSubmission(message.details)!] : []);
  const post = async (submission: string, thinking: string) => {
    const response = await handleChatRequest(new Request("http://fixture/api/chat", { method: "POST", body: JSON.stringify({ chatId: chat.id, input: {
      type: "plugin-problem-submission", problemId: snapshot.problemId, occurrence, submission, thinking,
    } }) }), factory);
    assert.equal(response.status, 200, await response.clone().text());
    const turn = runningTurn(chat.id); if (turn) await new Response(turn.subscribe()).text();
  };
  const wrong = "  function square(x) { return x; }  \n\n", revised = "  function square(x) { return x * x; }  \n\n";
  await post(wrong, "First reasoning");
  assert.equal(submissions().length, 1);
  assert.equal(submissions()[0]!.submission, wrong);
  assert.equal(submissions()[0]!.thinking, "First reasoning");
  assert.equal(readTestResult((submissions()[0]!.processing as { result: unknown }).result)?.status, "failed");
  assert.match(modelInputs[0]!, /Expected 9/);
  assert.ok(activeProblemOf(saved().messages));
  await post(revised, "Revised reasoning");
  assert.equal(submissions().length, 2);
  assert.equal(submissions()[1]!.submission, revised);
  assert.equal(submissions()[1]!.thinking, "Revised reasoning");
  assert.equal(readTestResult((submissions()[1]!.processing as { result: unknown }).result)?.status, "passed");
  assert.match(modelInputs[1]!, /Observed test passed/);
  assert.ok(activeProblemOf(saved().messages), "Passing tests alone do not close the problem");
  assert.equal(modelSolutionForConclude(saved().messages, "coding-conclude"), undefined);
  await post(revised, "Ready for final assessment");
  assert.equal(submissions().length, 3);
  assert.equal(factories, 3, "Exactly one normal continuation per accepted attempt");
  assert.equal(activeProblemOf(saved().messages), null);
  assert.equal(modelSolutionForConclude(saved().messages, "coding-conclude"), input.modelSolution);
  assert.deepEqual(fs.readdirSync(path.join(ctx.dataDirectory, "test-runs", snapshot.problemId)), []);
});

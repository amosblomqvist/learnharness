import assert from "node:assert/strict";
import test from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { SessionModel } from "../components/session-core.ts";
import type { PluginFrontendContext, PluginInfo, PluginProblemSnapshot, PluginProblemEditorProps, LhMessage } from "../src/core/index.ts";

const snapshot: PluginProblemSnapshot = { protocolVersion: 1, problemId: "p", pluginId: "fixture", typeId: "code", label: "Code", contractVersion: 1,
  input: { statement: "Code", mode: "composition", modelSolution: "solution", payload: {} }, problemSchema: { type: "object" }, submissionSchema: { type: "string" }, requiresProcessing: false, requiresSubmissionRefinement: false };
const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "code_problem" };
const messages = [{ id: "pose", role: "assistant", content: [{ type: "toolCall", id: "call", name: "code_problem", arguments: snapshot.input }] },
  { id: "ack", role: "toolResult", toolCallId: "call", toolName: "code_problem", content: [], isError: false, details: { pluginProblem: snapshot } }] as unknown as LhMessage[];

test("problem renderer registration is owner-scoped, receiver-bound and removed with activation", async () => {
  const info = (id: string): PluginInfo => ({ id, enabled: true, status: "active", revision: "1", manifest: { apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "index.js" } });
  const contexts: PluginFrontendContext[] = [];
  const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), pathname: () => "/", navigate() {}, async importModule() { return { activate(context) {
    contexts.push(context);
    context.registerProblemRenderer({ id: "code", supportedContractVersions: [1], mountSubmissionEditor() { assert.equal(this.id, "code"); return { update() {}, focus() {}, dispose() {} }; } });
  } }; } });
  try {
    manager.reconcile([info("one"), info("two")]); await new Promise<void>(resolve => setImmediate(resolve));
    const registrations = manager.getSnapshot().problemRenderers!;
    assert.deepEqual(registrations.map(entry => entry.pluginId), ["one", "two"]);
    registrations[0]!.renderer.mountSubmissionEditor({} as HTMLElement, {} as PluginProblemEditorProps);
    assert.throws(() => contexts[0]!.registerProblemRenderer({ ...registrations[0]!.renderer, supportedContractVersions: [] }), /contract versions/);
    manager.reconcile([info("two")]); assert.deepEqual(manager.getSnapshot().problemRenderers!.map(entry => entry.pluginId), ["two"]);
  } finally { manager.dispose(); }
});

test("server-read availability gates practice sends, and active draft identity survives canonical adoption", async () => {
  let available = false; let posts = 0;
  const model = new SessionModel({ chatId: "chat", initialMessages: messages, fetch: async (url, init) => {
    if (init?.method === "POST") { posts++; return new Response("Busy", { status: 409 }); }
    assert.equal(String(url), "/api/chats/chat");
    return Response.json({ messages, pluginProblemAvailability: { problemId: "p", status: available ? "available" : "unavailable" } });
  } });
  const draft = model.pluginProblemDraft(snapshot); draft.submission = { status: "ready", value: "draft code" }; draft.thinking = "trace";
  const input = { type: "plugin-problem-submission" as const, problemId: "p", occurrence, submission: "draft code" };
  assert.equal(await model.send(input), false); assert.equal(posts, 0);
  await model.reconcile(); assert.equal(model.getState().pluginProblemAvailability?.status, "unavailable");
  assert.equal(await model.send(input), false); assert.equal(posts, 0);
  available = true; await model.reconcile(); assert.equal(model.pluginProblemDraft(snapshot), draft);
  assert.equal(model.getState().pluginProblemAvailability?.status, "available");
  assert.equal(await model.send({ ...input, occurrence: { ...occurrence, messageId: "stale" } }), false); assert.equal(posts, 0);
  assert.equal(await model.send(input), false); assert.equal(posts, 1); assert.equal(model.pluginProblemDraft(snapshot), draft);
  assert.equal(draft.thinking, "trace"); assert.deepEqual(draft.submission, { status: "ready", value: "draft code" });
});

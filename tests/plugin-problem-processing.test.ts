import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore } from "@earendil-works/pi-ai";
import { prepareProblemSubmissionImageChannels } from "../src/server/submission-images.ts";
import { preparePluginProblemType, readPluginProblemSubmission, type PluginProblemTypeDefinition } from "../src/core/plugin-problems.ts";
import { preparePluginProblemSubmission, pluginProblemAvailabilityOf } from "../src/server/plugin-problems.ts";
import { activeProblemOf, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { preparePluginSubmission, type PluginSubmissionTarget } from "../src/core/plugin-submissions.ts";
import { SessionModel } from "../components/session-core.ts";

const image = { type: "image" as const, mimeType: "image/png", data: "YQ==" };
const input = { statement: "Code", mode: "composition", modelSolution: "solution", payload: {} };
const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "code_problem" };
function fixture(overrides: Partial<PluginProblemTypeDefinition> = {}) {
  const definition = preparePluginProblemType({ id: "code", label: "Code", contractVersion: 1,
    tool: { toolName: "code_problem", description: "Pose code" }, problemSchema: Type.Object({}), submissionSchema: Type.String(), ...overrides });
  const snapshot = { protocolVersion: 1, problemId: "problem-one", pluginId: "example", typeId: definition.id, label: definition.label,
    contractVersion: 1, input, problemSchema: definition.problemSchema, submissionSchema: definition.submissionSchema,
    requiresSubmissionRefinement: !!definition.validateSubmission, requiresProcessing: !!definition.processSubmission };
  const record = { id: "chat", kind: "practice", messages: [
    { id: "pose", role: "assistant", content: [{ type: "toolCall", id: "call", name: "code_problem", arguments: input }] },
    { id: "ack", role: "toolResult", toolCallId: "call", toolName: "code_problem", content: [], isError: false, details: { pluginProblem: snapshot } },
  ] as unknown as LhMessage[] };
  const activation = new AbortController(); let current = true;
  const resolve = () => ({ status: "available" as const, definition, signal: activation.signal, requireActive() { if (!current) throw Error("Gone"); } });
  const submission = { type: "plugin-problem-submission" as const, problemId: "problem-one", occurrence, submission: "code", thinking: "Why it works" };
  return { record, resolve, submission, activation, disable() { current = false; activation.abort(); } };
}

test("each structured submission processes before saving, stays active and keeps thinking separate", async () => {
  let calls = 0;
  const f = fixture({ processSubmission: async context => {
    calls++; assert.equal(context.thinking, "Why it works"); assert.equal(context.submission, "code");
    assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.input)); assert.equal(Object.isFrozen(context.signal), false);
    return { passed: true };
  } });
  for (let index = 0; index < 2; index++) {
    const prepared = preparePluginProblemSubmission(f.record, f.submission, f.resolve);
    assert.throws(() => prepared.finish(f.record), /has not completed/);
    const outcome = await prepared.process!(new AbortController().signal);
    assert.deepEqual(outcome, { result: { passed: true } });
    const appends = prepared.finish(f.record, outcome); f.record.messages.push(...appends);
    const saved = readPluginProblemSubmission((appends[0] as { details: unknown }).details)!;
    assert.equal(saved.submission, "code"); assert.equal(saved.thinking, "Why it works"); assert.equal(saved.processing && "result" in saved.processing, true);
    assert.equal(activeProblemOf(f.record.messages)?.pluginProblem?.problemId, "problem-one");
  }
  assert.equal(calls, 2);
});

test("processing preserves finite JSON falsy results and accepts invalid results only as errors", async () => {
  for (const value of [false, null, 0, "", undefined, NaN, new Date()]) {
    const f = fixture({ processSubmission: () => value as never });
    const prepared = preparePluginProblemSubmission(f.record, f.submission, f.resolve);
    const outcome = await prepared.process!(new AbortController().signal);
    if (value === undefined || Number.isNaN(value) || value instanceof Date) assert.equal("error" in outcome, true);
    else assert.deepEqual(outcome, { result: value });
    assert.ok(prepared.finish(f.record, outcome));
  }
});

test("practice image channels reuse actual byte, resize and current-model admission", async () => {
  const canvas = createCanvas(8, 4); canvas.getContext("2d").fillRect(0, 0, 8, 4);
  const source = { type: "image" as const, mimeType: "image/png", data: canvas.toBuffer("image/png").toString("base64") };
  const model = { ...createFauxCore({}).getModel(), input: ["text", "image"] as ("text" | "image")[],
    inputLimits: { images: { resize: { maxWidth: 2, maxHeight: 2, maxBytes: 2048 } } } };
  const prepared = await prepareProblemSubmissionImageChannels({ submission: [source], thinking: [source] }, { model });
  assert.deepEqual(Object.keys(prepared!).sort(), ["submission", "thinking"]);
  assert.equal(prepared!.submission!.length, 1); assert.equal(prepared!.thinking!.length, 1);
  assert.notEqual(prepared!.submission![0]!.data, source.data);
  const textOnly = { model: { ...model, input: ["text"] as ("text" | "image")[] } };
  await assert.rejects(prepareProblemSubmissionImageChannels({ submission: [source] }, textOnly), /does not support images/);
  await assert.rejects(prepareProblemSubmissionImageChannels({ thinking: [{ ...source, mimeType: "image/jpeg" }] }, { model }));
  assert.equal(await prepareProblemSubmissionImageChannels({ submission: [], thinking: [] }, textOnly), undefined);
});

test("processing errors are observations while cancellation and stale target prevent saving", async () => {
  const f = fixture({ processSubmission() { const error = Error("Tests could not run"); error.name = "AbortError"; throw error; } });
  const prepared = preparePluginProblemSubmission(f.record, f.submission, f.resolve);
  const outcome = await prepared.process!(new AbortController().signal);
  assert.deepEqual(outcome, { error: "Tests could not run" });
  assert.ok(prepared.finish(f.record, outcome));
  f.record.messages.push({ id: "dismiss", role: "custom", customType: "problem-dismissed", content: "", display: true, details: { problemCallId: "call" }, timestamp: 0 });
  assert.throws(() => prepared.finish(f.record, outcome), /no longer active/);
  const cancelled = fixture({ processSubmission: async () => true });
  const pending = preparePluginProblemSubmission(cancelled.record, cancelled.submission, cancelled.resolve);
  cancelled.disable();
  await assert.rejects(pending.process!(new AbortController().signal), /unavailable/);
  assert.throws(() => pending.finish(cancelled.record, { result: true }), /unavailable/);
});

test("saved requirements and validation cannot be bypassed with a native practice send", () => {
  const f = fixture({ validateSubmission: () => ["Invalid code"] });
  assert.throws(() => preparePluginProblemSubmission(f.record, f.submission, f.resolve), /Invalid code/);
  assert.throws(() => inputAppends(f.record, { type: "thinking", problemCallId: "call", text: "bypass" }), /registered submission editor/);
  assert.throws(() => preparePluginProblemSubmission(f.record, { ...f.submission, occurrence: { ...occurrence, messageId: "older" } }, f.resolve), /no longer active/);
  assert.equal(pluginProblemAvailabilityOf(f.record, () => ({ status: "incompatible" }))?.status, "unavailable");
  assert.equal(activeProblemOf(f.record.messages)?.toolCallId, "call");
});

test("intercepted practice submissions keep native images separate from JSON and project real model image blocks", () => {
  const f = fixture();
  const target = { type: "plugin-problem-submission", channels: ["submission", "thinking"], sessionKind: "practice", sessionId: "chat", surfaceTarget: {}, problem: { problemId: "problem-one", pluginId: "example", typeId: "code", label: "Code", contractVersion: 1, occurrence, statement: "Code" } } as unknown as PluginSubmissionTarget;
  const prepared = preparePluginSubmission({ type: "plugin-problem-submission", submission: "code", submissionImages: [image], thinking: { text: "Why it works", images: [image] } }, target);
  assert.equal(prepared.type, "plugin-problem-submission"); assert.ok(Object.isFrozen(prepared));
  const posted = parseChatInput({ ...f.submission, images: { submission: [image], thinking: [image] } });
  assert.equal(posted.type, "plugin-problem-submission");
  if (posted.type !== "plugin-problem-submission") return;
  const appends = preparePluginProblemSubmission(f.record, posted, f.resolve).finish(f.record);
  const wire = toLlmMessages(appends);
  assert.equal(wire[0]?.role, "user");
  const blocks = wire[0]!.content as { type: string; text?: string }[];
  assert.equal(blocks.filter(block => block.type === "image").length, 2);
  assert.equal(blocks.some(block => block.type === "text" && block.text?.includes(image.data)), false);
  assert.throws(() => parseChatInput({ ...f.submission, images: { readingThinking: [image] } }), /Invalid/);
});

test("plugin practice 409 responses never automatically repost processing", async () => {
  const f = fixture(); let posts = 0;
  const model = new SessionModel({ chatId: "chat", initialMessages: f.record.messages, fetch: async () => { posts++; return new Response("Busy", { status: 409 }); } });
  const response = await model.postInputEvent(f.submission);
  assert.equal(response.status, 409); assert.equal(await response.text(), "Busy"); assert.equal(posts, 1);
});

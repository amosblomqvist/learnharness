import assert from "node:assert/strict";
import { test } from "node:test";
import { Format } from "typebox/format";
import { Settings } from "typebox/system";
import { Type } from "typebox";
import { SessionModel } from "../components/session-core.ts";
import { copyImmutableData, ImmutableReadCache } from "../src/core/immutable-data.ts";
import { pluginQuestionCallsOf, pendingPluginQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { posedPluginQuestionOfPart, parseQuizInput } from "../src/core/tool-parts.ts";
import { preparePluginQuestionSchema, readPluginQuestionSnapshot, readPluginQuestionMessageAnnotation, readPluginQuestionAnswer, validatePluginQuestionAnswer, type PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";
import { createPluginProblemParameters, preparePluginProblemType, readPluginProblemSnapshot, validatePluginProblemSubmission, type PluginProblemSnapshot } from "../src/core/plugin-problems.ts";
import { validatePluginSchema } from "../src/core/plugin-validation.ts";

const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "code_question" };
function question(): PluginQuestionSnapshot {
  return { protocolVersion: 1, questionId: "question", occurrence: { ...occurrence }, pluginId: "coding", typeId: "code", label: "Code", variant: "probe", contractVersion: 1,
    input: { question: "Write code.", payload: { source: "starter" } }, questionSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
    answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false };
}
function history(): LhMessage[] {
  return [{ id: "pose", role: "assistant", content: [{ type: "toolCall", id: "call", name: "code_question", arguments: {} }], lhQuestions: { "0": question() }, timestamp: 1 },
    { id: "answer", role: "toolResult", toolCallId: "call", toolName: "code_question", lhQuestionOccurrence: { ...occurrence }, content: [], isError: false, timestamp: 2,
      details: { kind: "plugin-question", questionId: "question", pluginId: "coding", typeId: "code", contractVersion: 1, answer: "code", answeredAt: "2026-11-07T10:00:00.000Z" } }] as unknown as LhMessage[];
}
function problem(): PluginProblemSnapshot {
  return { protocolVersion: 1, problemId: "problem", pluginId: "coding", typeId: "code", label: "Code", contractVersion: 1,
    input: { statement: "Write code.", mode: "composition", modelSolution: "solution", payload: { source: "starter" } },
    problemSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] }, submissionSchema: { type: "string" }, requiresSubmissionRefinement: false, requiresProcessing: false };
}
function compilations(run: () => void): number {
  // Count actual TypeBox JIT construction, not wall-clock timing. No production test hooks.
  validatePluginSchema({ type: "boolean" });
  const original = globalThis.Function;
  let count = 0;
  globalThis.Function = new Proxy(original, { construct(target, args) { count++; return Reflect.construct(target, args); } });
  try { run(); } finally { globalThis.Function = original; }
  return count;
}

test("owned history copies are detached, preserve native undefined fields and never invoke accessors", () => {
  let reads = 0;
  const source = { nested: { value: 1 }, optional: undefined };
  const owned = copyImmutableData(source);
  assert.notEqual(owned, source); assert.ok(Object.isFrozen(owned.nested)); assert.equal(Object.isFrozen(source.nested), false);
  assert.ok(Object.hasOwn(owned, "optional")); assert.equal(copyImmutableData(owned), owned);
  source.nested.value = 2; assert.equal(owned.nested.value, 1);
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { reads++; return source.nested.value; } });
  const copy = copyImmutableData(accessor); assert.equal(reads, 0);
  const memo = new ImmutableReadCache<number>();
  assert.equal(memo.read(copy, undefined, () => ++reads), 1);
  assert.equal(memo.read(copy, undefined, () => ++reads), 2, "accessor-bearing frozen data is not cacheable");
  const shallow = Object.freeze({ child: { n: 1 } });
  assert.equal(memo.read(shallow, undefined, () => shallow.child.n), 1);
  shallow.child.n = 2;
  assert.equal(memo.read(shallow, undefined, () => shallow.child.n), 2, "shallow freezing never certifies nested mutable input");
  let changing = 1;
  const proxy = new Proxy(Object.freeze({}), { get(_target, key) { return key === "changing" ? changing : undefined; } }) as { changing: number };
  assert.equal(memo.read(proxy, undefined, () => proxy.changing), 1);
  changing = 2;
  assert.equal(memo.read(proxy, undefined, () => proxy.changing), 2, "even a frozen proxy is not an owned snapshot");
  assert.equal(Object.hasOwn(copyImmutableData(proxy), "changing"), false, "only captured own data is adopted");
});

test("unchanged immutable question history reuses parsed contracts, answers and pending analysis without compiling again", () => {
  const messages = copyImmutableData(history());
  const first = readPluginQuestionMessageAnnotation(messages[0], 0);
  assert.equal(first.status, "posed"); if (first.status !== "posed") return;
  const calls = pluginQuestionCallsOf(messages); assert.deepEqual(calls, []);
  const details = (messages[1] as LhMessage & { details: unknown }).details;
  const savedAnswer = readPluginQuestionAnswer(details, first.snapshot);
  const projected = projectView(messages); const part = projected.flatMap(m => m.parts).find(p => p.pluginQuestion)!;
  assert.ok(posedPluginQuestionOfPart(part));
  assert.equal(compilations(() => {
    for (let i = 0; i < 20; i++) {
      assert.equal(readPluginQuestionMessageAnnotation(messages[0], 0), first);
      assert.equal(readPluginQuestionSnapshot(first.snapshot), first.snapshot);
      assert.equal(pluginQuestionCallsOf(messages), calls);
      assert.equal(readPluginQuestionAnswer(details, first.snapshot), savedAnswer);
      assert.equal(posedPluginQuestionOfPart(part), first.snapshot);
      projectView(messages);
    }
  }), 0);
});

test("mutable records still revalidate, and cached questions retain exact occurrence binding", () => {
  const raw = question(); const original = readPluginQuestionSnapshot(raw)!;
  raw.input.payload = { source: 7 };
  assert.equal(readPluginQuestionSnapshot(raw), null);
  raw.questionSchema = { type: "object", properties: { source: { type: "number" } }, required: ["source"] };
  assert.deepEqual(readPluginQuestionSnapshot(raw)?.input.payload, { source: 7 });
  assert.deepEqual(original.input.payload, { source: "starter" });
  const messages = copyImmutableData(history()); const good = readPluginQuestionMessageAnnotation(messages[0], 0);
  const moved = copyImmutableData({ ...messages[0], id: "another-occurrence" });
  assert.equal(readPluginQuestionMessageAnnotation(moved, 0).status, "unreadable");
  assert.equal(readPluginQuestionMessageAnnotation(messages[0], 0), good);
  const changed = copyImmutableData([{ ...messages[0], lhQuestions: { "0": { ...question(), answerSchema: { type: "number" } } } }, messages[1]]) as LhMessage[];
  assert.ok(pendingPluginQuestionOf(changed), "a previously accepted answer cannot settle a changed saved contract");
});

test("format registry changes invalidate prepared-schema and historical-read caches", () => {
  const raw = question(); raw.questionSchema = { type: "string", format: "email" }; raw.input.payload = "user@example.com";
  const messages = copyImmutableData([{ ...history()[0]!, lhQuestions: { "0": raw } }]);
  assert.equal(readPluginQuestionMessageAnnotation(messages[0], 0).status, "posed");
  assert.equal(pluginQuestionCallsOf(messages)[0]?.status, "answerable");
  const schema = preparePluginQuestionSchema({ type: "string", format: "email" });
  const original = Format.Get("email")!;
  try {
    Format.Set("email", () => true);
    assert.equal(readPluginQuestionMessageAnnotation(messages[0], 0).status, "unreadable");
    assert.equal(pluginQuestionCallsOf(messages)[0]?.status, "unreadable");
    assert.throws(() => preparePluginQuestionSchema(schema), /format/);
  } finally { Format.Set("email", original); }
  assert.equal(readPluginQuestionMessageAnnotation(messages[0], 0).status, "posed");
});

test("practice problem history shares prepared-contract reuse, but each new submission and refinement still runs", () => {
  const raw = copyImmutableData(problem()); const saved = readPluginProblemSnapshot(raw)!;
  const d = preparePluginProblemType({ id: "code", label: "Code", contractVersion: 1, tool: { toolName: "code_problem", description: "Code" }, problemSchema: Type.Object({ source: Type.String() }), submissionSchema: Type.String() });
  const parameters = createPluginProblemParameters(d);
  validatePluginProblemSubmission(saved, { chatId: "c", submission: "ok" });
  assert.equal(compilations(() => {
    for (let i = 0; i < 10; i++) {
      assert.equal(readPluginProblemSnapshot(raw), saved); assert.equal(readPluginProblemSnapshot(saved), saved);
      assert.equal(createPluginProblemParameters(d), parameters);
      assert.equal(validatePluginProblemSubmission(saved, { chatId: "c", submission: "ok" }).ok, true);
      assert.equal(validatePluginProblemSubmission(saved, { chatId: "c", submission: 4 }).ok, false);
    }
  }), 0);
  let runs = 0;
  const refining = { id: d.id, label: d.label, contractVersion: d.contractVersion, tool: d.tool,
    problemSchema: d.problemSchema, submissionSchema: d.submissionSchema, validateSubmission: () => { runs++; return ["No"]; } };
  const required = readPluginProblemSnapshot(copyImmutableData({ ...problem(), requiresSubmissionRefinement: true }))!;
  for (let i = 0; i < 3; i++) assert.equal(validatePluginProblemSubmission(required, { chatId: "c", submission: "ok" }, refining).ok, false);
  assert.equal(runs, 3);
  let answers = 0;
  const q = readPluginQuestionSnapshot(copyImmutableData({ ...question(), requiresAnswerRefinement: true }))!;
  const current = { id: "code", label: "Code", contractVersion: 1, showThinking: false, questionSchema: q.questionSchema, answerSchema: q.answerSchema, probe: { toolName: "code_question", description: "Code" }, validateAnswer: () => { answers++; return ["No"]; } };
  for (let i = 0; i < 3; i++) assert.equal(validatePluginQuestionAnswer(q, { chatId: "c", answer: "ok" }, current).ok, false);
  assert.equal(answers, 3);
});

test("session ownership reuses unchanged history, adopts changed records and detaches streamed partials", () => {
  const seed = history(); const model = new SessionModel({ chatId: "c", initialMessages: seed });
  const first = model.getState().nativeMessages; projectView(first); pluginQuestionCallsOf(first);
  assert.notEqual(first[0], seed[0]); assert.equal(Object.isFrozen(seed[0]), false);
  assert.equal(compilations(() => { model.clearError(); for (let i = 0; i < 5; i++) { assert.equal(model.getState().nativeMessages, first); pluginQuestionCallsOf(model.getState().canonicalMessages); } }), 0);
  const partial = { id: "stream", role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 3 };
  model.applyWireEvent({ type: "message_start", message: partial });
  const before = model.getState().nativeMessages;
  partial.content[0]!.text = "updated";
  assert.deepEqual(before.at(-1)?.content, [{ type: "text", text: "first" }]);
  model.applyWireEvent({ type: "message_update", message: partial });
  assert.deepEqual(model.getState().nativeMessages.at(-1)?.content, [{ type: "text", text: "updated" }]);
  assert.equal(model.getState().nativeMessages[0], first[0], "streaming does not recopy settled history");
  const changed = history(); (changed[0]!.lhQuestions!["0"] as PluginQuestionSnapshot).answerSchema = { type: "number" };
  model.setMessages(changed);
  assert.ok(pendingPluginQuestionOf(model.getState().canonicalMessages));
});

test("native questions and ordinary plugin-tool display do not acquire dynamic historical contracts", () => {
  const input = { question: "Pick", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a", explanation: "A is correct." };
  assert.ok(parseQuizInput(input));
  const raw = [{ id: "tool", role: "assistant", content: [{ type: "toolCall", id: "ordinary", name: "custom_tool", arguments: { x: 1 } }], timestamp: 1 },
    { id: "result", role: "toolResult", toolCallId: "ordinary", toolName: "custom_tool", content: [{ type: "text", text: "result" }], details: { ok: true }, timestamp: 2, isError: false }] as unknown as LhMessage[];
  const model = new SessionModel({ chatId: "generic", initialMessages: raw });
  const first = model.getState().messages.flatMap(m => m.parts).find(p => p.type === "tool-custom_tool")!;
  assert.ok(first.result);
  assert.equal(compilations(() => {
    model.clearError();
    const next = model.getState().messages.flatMap(m => m.parts).find(p => p.type === "tool-custom_tool")!;
    assert.equal(next.input, first.input); assert.equal(next.output, first.output); assert.equal(next.result?.content, first.result?.content);
    assert.equal(next.pluginQuestion, undefined); assert.equal(next.pluginProblem, undefined); assert.ok(parseQuizInput(input));
  }), 0);
});

test("cached answer checks do not cross contracts, and duplicate call ids retain occurrence-specific authority", () => {
  const messages = copyImmutableData(history());
  const first = readPluginQuestionSnapshot((messages[0]!.lhQuestions!["0"]))!;
  const details = (messages[1] as { details: Record<string, unknown> }).details;
  assert.ok(readPluginQuestionAnswer(details, first));
  const different = readPluginQuestionSnapshot(copyImmutableData({ ...question(), answerSchema: { type: "number" } }))!;
  assert.equal(readPluginQuestionAnswer(details, different), null);
  assert.ok(readPluginQuestionAnswer(details, first));
  assert.equal(readPluginQuestionAnswer(copyImmutableData({ ...details, answer: 4 }), first), null);
  const nextOccurrence = { ...occurrence, messageId: "pose-2" };
  const second = { ...messages[0], id: "pose-2", lhQuestions: { "0": { ...question(), questionId: "question-2", occurrence: nextOccurrence } } };
  const duplicateIds = copyImmutableData([messages[0], second, messages[1]]) as LhMessage[];
  const calls = pluginQuestionCallsOf(duplicateIds);
  assert.deepEqual(calls.map(call => call.snapshot?.questionId), ["question-2"]);
  assert.equal(pluginQuestionCallsOf(duplicateIds), calls);
  const settled = copyImmutableData([...duplicateIds, { ...messages[1], id: "answer-2", lhQuestionOccurrence: nextOccurrence, details: { ...details, questionId: "question-2" } }]) as LhMessage[];
  assert.deepEqual(pluginQuestionCallsOf(settled), []);
});

test("malformed immutable versions and changed practice contracts do not reuse prior authority; boolean schemas also reuse compilation", () => {
  const unknown = copyImmutableData({ ...question(), protocolVersion: 99 });
  assert.equal(readPluginQuestionSnapshot(unknown), null);
  assert.ok(readPluginQuestionSnapshot(copyImmutableData({ ...unknown, protocolVersion: 1 })));
  const original = copyImmutableData(problem()); assert.ok(readPluginProblemSnapshot(original));
  assert.equal(readPluginProblemSnapshot(copyImmutableData({ ...original, problemSchema: { type: "number" } })), null);
  const boolean = readPluginQuestionSnapshot(copyImmutableData({ ...question(), answerSchema: true }))!;
  assert.ok(boolean);
  validatePluginQuestionAnswer(boolean, { chatId: "c", answer: false });
  assert.equal(compilations(() => {
    for (const answer of [false, null, "text", 4]) assert.equal(validatePluginQuestionAnswer(boolean, { chatId: "c", answer }).ok, true);
  }), 0);
});

test("validation policy changes invalidate reuse, while unowned contexts never qualify", () => {
  const cache = new ImmutableReadCache<number>(), input = copyImmutableData({ stable: true });
  let computations = 0;
  assert.equal(cache.read(input, undefined, () => ++computations), 1);
  assert.equal(cache.read(input, undefined, () => ++computations), 1);
  const original = Settings.Get().exactOptionalPropertyTypes;
  try {
    Settings.Set({ exactOptionalPropertyTypes: !original });
    assert.equal(cache.read(input, undefined, () => ++computations), 2);
  } finally { Settings.Set({ exactOptionalPropertyTypes: original }); }
  const context = { n: 1 };
  assert.equal(cache.read(input, context, () => context.n), 1);
  context.n = 2;
  assert.equal(cache.read(input, context, () => context.n), 2);
});

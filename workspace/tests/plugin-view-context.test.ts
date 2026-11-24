import assert from "node:assert/strict";
import test from "node:test";
import { capturePluginSessionView, createPluginSessionActionContext, type PluginSessionViewInput } from "../src/core/plugin-view-context.ts";
import type { PluginSurfaceTarget } from "../src/core/plugin-ui.ts";
const surfaceTarget = {} as PluginSurfaceTarget;
function source(): Parameters<typeof capturePluginSessionView>[0] {
  return { sessionId: "one", kind: "teaching", title: "Whole conversation", messages: [{ id: "first", role: "custom", customType: "subagent-steer", content: "Earlier learner message", details: {}, display: true, timestamp: 0 }], transcript: [{ id: "first", role: "user", parts: [{ type: "text", text: "Earlier learner message" }] }],
    status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: "teach", contextTokens: 123, queuedSteers: [], composer: { text: "  retained composer\n" },
    input: { type: "answer", sessionId: "one", sessionKind: "teaching", surfaceTarget, channels: ["answer", "thinking", "readingThinking"],
      question: { id: "call", kind: "ask", question: "Current question", context: "Details", mode: "multi-select", options: [{ value: "b", label: "Second", description: "**Visible**" }, { value: "a", label: "First" }], occurrence: { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "ask_user_question" } },
      expanded: false, revealed: false, available: true, draft: { dontKnow: false, values: ["b"], otherSelected: true, other: "  custom  ", text: "", thinking: "  thinking\n", readingThinking: "reading" } } };
}
test("whole-view snapshots retain history, host display order/visibility and untrimmed unsent input without freezing opaque targets", () => {
  const input = source(), view = capturePluginSessionView(input);
  assert.notEqual(view, input); assert.ok(Object.isFrozen(view.messages[0])); assert.ok(Object.isFrozen(view.transcript[0]!.parts));
  assert.equal(view.composer.text, "  retained composer\n"); assert.equal(view.input.type, "answer");
  if (view.input.type !== "answer") return;
  assert.deepEqual(view.input.question.options.map(option => option.value), ["b", "a"]);
  assert.equal(view.input.revealed, false); assert.equal(view.input.draft.other, "  custom  ");
  assert.ok(Object.isFrozen(view.input.draft.values)); assert.equal(view.input.surfaceTarget, surfaceTarget); assert.equal(Object.isFrozen(surfaceTarget), false);
  assert.throws(() => { (view.messages[0] as { content: unknown }).content = "mutated"; }, TypeError);
  (input.composer as { text: string }).text = "newer edit";
  assert.equal(view.composer.text, "  retained composer\n");
});
test("view contexts cover custom question/problem payloads and every published editor state without narrowing visibility", () => {
  const base = { sessionId: "one", surfaceTarget, contractVersion: 1, pluginId: "custom", typeId: "code", label: "Code" };
  const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "custom_problem" };
  for (const type of ["plugin-question-answer", "plugin-problem-submission"] as const) for (const editor of [{ status: "empty" as const }, { status: "unready" as const, value: false }, { status: "ready" as const, value: { nested: [0, null, ""] } }]) {
    const input: PluginSessionViewInput = type === "plugin-question-answer"
      ? { ...base, type, sessionKind: "teaching", channels: ["answer", "thinking"], question: { ...base, occurrence, questionId: "question", variant: "probe", showThinking: true }, expanded: false, revealed: false, available: false,
          input: { question: "Custom question", payload: { reference: "Whole view includes custom input too" } }, draft: { answer: editor, thinking: "custom thinking", readingThinking: "reading" } }
      : { ...base, type, sessionKind: "practice", channels: ["submission", "thinking"], problem: { ...base, occurrence, problemId: "problem", statement: "Custom problem" }, expanded: true, available: false,
          input: { statement: "Custom problem", mode: "composition", modelSolution: "Saved input is available", payload: { starter: "code" } }, draft: { submission: editor, thinking: "custom thinking" } };
    const view = capturePluginSessionView({ ...source(), input });
    assert.deepEqual(view.input, input); assert.notEqual(view.input, input);
    if (view.input.type !== "plugin-question-answer" && view.input.type !== "plugin-problem-submission") return;
    assert.ok(Object.isFrozen(view.input.input.payload)); assert.ok(Object.isFrozen(view.input.draft));
    assert.equal(view.input.surfaceTarget, surfaceTarget); assert.equal("onAccepted" in view, false);
  }
});
test("unavailable input remains a frozen, identifiable view state rather than a guessed composer", () => {
  const input = { type: "unavailable" as const, expanded: false, revealed: false, occurrence: { messageId: "unreadable", contentIndex: 1, toolCallId: "call", toolName: "unknown_question" } };
  const view = capturePluginSessionView({ ...source(), input });
  assert.deepEqual(view.input, input); assert.ok(Object.isFrozen(view.input));
  assert.notEqual(view.input, input); assert.ok(Object.isFrozen(view.messages));
});

test("action contexts snapshot once per context and fresh invocations never mutate or retarget older captures", () => {
  const data = source(); let reads = 0;
  const read = () => { reads++; return data; };
  const base = { placement: "top-bar", surface: "session", sessionId: "one", kind: "teaching", surfaceTarget } as const;
  const first = createPluginSessionActionContext(base, read); assert.equal(reads, 0);
  const original = first.view; assert.equal(first.view, original); assert.equal(reads, 1);
  (data.composer as { text: string }).text = "new draft";
  const next = createPluginSessionActionContext(base, read); assert.equal(next.view.composer.text, "new draft");
  assert.equal(original.composer.text, "  retained composer\n"); assert.equal(original.sessionId, "one"); assert.equal(reads, 2);
});

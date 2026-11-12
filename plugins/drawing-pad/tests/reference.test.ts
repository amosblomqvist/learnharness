import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginSessionViewInput } from "learnharness-plugin-api";
import { referenceFor } from "../src/reference.ts";
const question = { id: "q", kind: "quiz", question: "$x^2$?", context: "**Context**", mode: "single-select",
  options: [{ value: "b", label: "$b$", description: "do not leak old quiz description" }, { value: "a", label: "$a$" }],
  occurrence: { messageId: "m", contentIndex: 0, toolCallId: "q", toolName: "quiz" } };
function input(extra = {}): PluginSessionViewInput {
  return { type: "answer", question, revealed: true, available: true, ...extra } as unknown as PluginSessionViewInput;
}
it("preserves exact host option order and Markdown without quiz descriptions", () => {
  const reference = referenceFor(input())!;
  assert.equal(reference.question, "$x^2$?"); assert.equal(reference.context, "**Context**");
  assert.deepEqual(reference.options, [{ label: "$b$" }, { label: "$a$" }]); assert.equal(reference.extra, "I don't know");
});
it("unrevealed or unavailable native questions produce no reference", () => {
  assert.equal(referenceFor(input({ revealed: false })), undefined); assert.equal(referenceFor(input({ available: false })), undefined);
});
it("includes applicable non-quiz option descriptions without learner selections", () => {
  const reference = referenceFor(input({ question: { ...question, kind: "ask" }, draft: { values: ["a"], text: "private" } }))!;
  assert.equal(reference.options[0]!.description, "do not leak old quiz description");
  assert.equal(JSON.stringify(reference).includes("private"), false); assert.equal(reference.extra, "Other…");
});
it("text-mode questions have no artificial option rows", () => {
  const reference = referenceFor(input({ question: { ...question, mode: "text", kind: "explain" } }))!;
  assert.equal(reference.options.length, 0); assert.equal(reference.extra, undefined);
});
it("native practice uses the supplied statement, not model solution or draft", () => {
  const reference = referenceFor({ type: "thinking", problem: { statement: "Solve $x$", modelSolution: "secret" }, draft: { thinking: "unsent" } } as unknown as PluginSessionViewInput)!;
  assert.equal(reference.question, "Solve $x$"); assert.equal(JSON.stringify(reference).includes("secret"), false);
});
it("ordinary, custom question/problem and unavailable inputs start blank", () => {
  for (const type of ["text", "plugin-question-answer", "plugin-problem-submission", "unavailable"]) {
    assert.equal(referenceFor({ type, input: { payload: { secret: true } } } as unknown as PluginSessionViewInput), undefined);
  }
});

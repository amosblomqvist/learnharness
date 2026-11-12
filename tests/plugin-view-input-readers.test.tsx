import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import type { NativeQuestionViewState, ViewReaderRef } from "../components/session-view-readers.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });

for (const toolName of ["quiz", "ask_user_question"] as const) test(`view reads actual ${toolName} order, descriptions and drafts without saving or submitting`, async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let changes = 0; const reader: ViewReaderRef<NativeQuestionViewState> = { current: null, changed() { changes++; } };
  const input = { question: "Question", details: "Visible **context**", options: [{ label: "Alpha", value: "a", description: "**Detail A**" }, { label: "Beta", value: "b", description: "Detail B" }, { label: "Gamma", value: "c" }], correctAnswer: "a", explanation: "PRIVATE" };
  const fail = () => assert.fail("A view read must not save or submit");
  const render = async (expanded: boolean) => { await act(async () => root.render(<QuestionDock toolName={toolName} toolCallId="display-order" input={input} viewReader={reader} expanded={expanded} onExpand={() => {}} onSubmit={fail} onSaveDraft={fail} dictationClaim={false} />)); };
  try {
    await render(true); assert.ok(reader.current);
    const first = reader.current!();
    const labels = Array.from(host.querySelectorAll('[role="radio"]')).slice(0, first.question.options.length).map(button => (button.textContent ?? "").trim());
    assert.deepEqual(labels, first.question.options.map(option => option.label + (toolName === "ask_user_question" && option.description ? option.description.replaceAll("*", "") : "")));
    assert.equal(first.question.context, input.details);
    if (toolName === "ask_user_question") assert.equal(first.question.options[0]!.description, "**Detail A**");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
      const editor = host.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
      editor.textContent = "  untrimmed thinking\n"; editor.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const current = reader.current!(); assert.deepEqual(current.draft.values, [current.question.options[0]!.value]);
    assert.equal(current.draft.thinking, "  untrimmed thinking\n");
    if (toolName === "quiz") assert.equal(current.draft.confidence, 50);
    await render(false); assert.equal(reader.current!().draft.thinking, "  untrimmed thinking\n");
    assert.ok(changes > 1 && changes < 20, "Owner changes invalidate disabled predicates without a render loop");
  } finally { await act(async () => root.unmount()); host.remove(); }
  assert.equal(reader.current, null);
});

test("native practice view reads retain exact unsent thinking through collapse and clean up their generation", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const reader: ViewReaderRef<string> = { current: null };
  const render = async (expanded: boolean) => { await act(async () => root.render(<PracticeDock viewReader={reader} problemCallId="practice" input={{ statement: "Practice statement" }} expanded={expanded} onExpand={() => {}} onSubmit={() => assert.fail("Read must not submit")} />)); };
  try {
    await render(true);
    await act(async () => { const editor = host.querySelector<HTMLElement>('[data-file-path-input]')!; editor.textContent = "  reasoning\n"; editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assert.equal(reader.current!(), "  reasoning\n"); await render(false); assert.equal(reader.current!(), "  reasoning\n");
  } finally { await act(async () => root.unmount()); host.remove(); }
  assert.equal(reader.current, null);
});

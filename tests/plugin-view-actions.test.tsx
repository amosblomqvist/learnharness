import React, { act, useLayoutEffect, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { PluginSessionTopBarActions, PluginTopBarActions } from "../components/plugin-chrome.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import type { NativeQuestionViewState, ViewReaderRef } from "../components/session-view-readers.ts";
import { toClientQuestion } from "../src/core/question-core.ts";
import { usePlugins } from "../components/plugins.tsx";
import { TopBar } from "../components/top-bar.tsx";
import { createPluginSessionActionContext, type capturePluginSessionView, type PluginSessionViewContext } from "../src/core/plugin-view-context.ts";
import type { PluginFrontendContext } from "../src/core/plugins.ts";
import type { PluginSurfaceTarget } from "../src/core/plugin-ui.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";
const surfaceTarget = {} as PluginSurfaceTarget;
function source(): Parameters<typeof capturePluginSessionView>[0] {
  return { sessionId: "one", kind: "teaching", title: "Full session", messages: [], transcript: [], status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: "teach", contextTokens: null, queuedSteers: [], composer: { text: "first draft" },
    input: { type: "text", sessionId: "one", sessionKind: "teaching", surfaceTarget, channels: ["content"] } };
}
for (const overflow of [false, true]) test(`top-bar ${overflow ? "overflow" : "inline"} actions freshly capture the whole view before await`, async () => {
  const data = source(); let context!: PluginFrontendContext, captured: PluginSessionViewContext | undefined, after: PluginSessionViewContext | undefined;
  let resolve!: () => void; const pending = new Promise<void>(yes => { resolve = yes; });
  const make = () => createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: "one", kind: "teaching", surfaceTarget }, () => data);
  function Chrome() {
    usePlugins(); // Like Chat, consume host publication to refresh render-time predicates.
    return <TopBar><h1 data-plugin-chrome-title>Session</h1><div className="flex-1" /><PluginTopBarActions context={make()} captureContext={() => { const fresh = make(); void fresh.view; return fresh; }} /></TopBar>;
  }
  const fixture = await mountPluginChrome({ activate(ctx) { context = ctx; ctx.registerAction({ id: "view", name: "Read full view", disabled(action) { return action.surface !== "session" || action.view.composer.text === "disabled"; }, async run(action) {
    assert.equal(action.surface, "session"); if (action.surface !== "session") return;
    captured = action.view; await pending; after = action.view;
  } }); ctx.placeAction({ id: "view", actionId: "view", location: "top-bar", sessions: ["teaching"] }); } }, <Chrome />);
  try {
    if (overflow) { await fixture.resize(120); await fixture.click(fixture.document.querySelector<HTMLElement>('[aria-label="More plugin actions"]')!); }
    (data.composer as { text: string }).text = "newer draft, without a render";
    await fixture.click(fixture.document.querySelector<HTMLElement>('[data-plugin-action="fixture/view"]')!);
    assert.equal(captured?.composer.text, "newer draft, without a render"); assert.equal(captured?.sessionId, "one");
    (data.composer as { text: string }).text = "later draft";
    await act(async () => { context.refreshActions(); resolve(); await pending; });
    assert.equal(after, captured); assert.equal(after?.composer.text, "newer draft, without a render");
    assert.ok(Object.isFrozen(after?.composer));
  } finally { resolve(); await fixture.close(); }
});

for (const overflow of [false, true]) test(`question typing refreshes ${overflow ? "overflow" : "inline"} plugin actions after Strict Mode reconnection without rendering the session or transcript`, async () => {
  let ownerRenders = 0, transcriptRenders = 0;
  let refreshRefForTest!: React.RefObject<(() => void) | null>;
  const connections: Array<(() => void) | null> = [];
  const captured: string[] = [];
  const data = source();
  const input = { question: "Explain the result", correctAnswer: "Reference answer" };
  function Transcript() { transcriptRenders++; return <div>Unchanged lesson</div>; }
  function Session() {
    ownerRenders++;
    const refreshRef = useRef<(() => void) | null>(null);
    refreshRefForTest = refreshRef;
    useLayoutEffect(() => { connections.push(refreshRef.current); }, []);
    const reader = useRef<(() => NativeQuestionViewState) | null>(null) as ViewReaderRef<NativeQuestionViewState>;
    reader.changed = () => refreshRef.current?.();
    const make = () => createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: "one", kind: "teaching", surfaceTarget }, () => {
      const state = reader.current?.();
      return { ...data, input: state ? {
        type: "answer", sessionId: "one", sessionKind: "teaching", surfaceTarget, channels: ["answer"],
        question: { ...toClientQuestion(state.question), occurrence: { messageId: "message", contentIndex: 0, toolCallId: "question", toolName: "explain" } },
        expanded: true, revealed: true, available: true, draft: { ...state.draft, readingThinking: "" },
      } : data.input };
    });
    return <>
      <TopBar><h1 data-plugin-chrome-title>Session</h1><div className="flex-1" />
        <PluginSessionTopBarActions readContext={make} captureContext={() => { const fresh = make(); void fresh.view; return fresh; }} refreshRef={refreshRef} />
      </TopBar>
      <Transcript />
      <QuestionDock viewReader={reader} toolName="explain" toolCallId="question" input={input} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />
    </>;
  }
  const fixture = await mountPluginChrome({ activate(ctx) {
    ctx.registerAction({ id: "draft", name: "Read answer", disabled(action) {
      return action.surface !== "session" || action.view.input.type !== "answer" || !action.view.input.draft.text.trim();
    }, run(action) {
      if (action.surface === "session" && action.view.input.type === "answer") captured.push(action.view.input.draft.text);
    } });
    ctx.placeAction({ id: "draft", actionId: "draft", location: "top-bar", sessions: ["teaching"] });
  } }, <Session />, { strictMode: true });
  try {
    assert.ok(connections.length >= 2, "Strict Mode must exercise effect reconnection");
    assert.ok(connections[0]);
    assert.ok(refreshRefForTest.current);
    assert.notEqual(refreshRefForTest.current, connections[0], "reconnection must register a fresh refresh callback");
    if (overflow) { await fixture.resize(120); await fixture.click(fixture.document.querySelector<HTMLElement>('[aria-label="More plugin actions"]')!); }
    const button = () => fixture.document.querySelector<HTMLButtonElement>('[data-plugin-action="fixture/draft"]')!;
    assert.equal(button().disabled, true);
    const baseline = { owner: ownerRenders, transcript: transcriptRenders };
    const editor = fixture.document.querySelector<HTMLElement>('[data-file-path-input]')!;
    const type = async (text: string) => { await act(async () => {
      editor.textContent = text;
      editor.dispatchEvent(new window.Event("input", { bubbles: true }));
    }); };
    for (let i = 1; i <= 20; i++) await type("a".repeat(i));
    assert.equal(button().disabled, false, "draft notifications refresh the cached view used by disabled predicates");
    await type("");
    assert.equal(button().disabled, true);
    await type("latest answer");
    assert.equal(button().disabled, false);
    assert.equal(ownerRenders, baseline.owner, "typing must not render the session owner");
    assert.equal(transcriptRenders, baseline.transcript, "typing must not render unchanged transcript siblings");
    await fixture.click(button());
    assert.deepEqual(captured, ["latest answer"]);
  } finally { await fixture.close(); }
  assert.equal(refreshRefForTest.current, null, "unmount must release the refresh callback");
});

test("disabled predicates receive view data and capture failures are contained by plugin action error handling", async () => {
  const data = source(); let calls = 0;
  const make = () => createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: "one", kind: "teaching", surfaceTarget }, () => data);
  const fixture = await mountPluginChrome({ activate(ctx) { ctx.registerAction({ id: "view", name: "Read view", disabled(context) { return context.surface === "session" && context.view.composer.text === "disabled"; }, run() { calls++; } }); ctx.placeAction({ id: "view", actionId: "view", location: "top-bar", sessions: ["teaching"] }); } }, <TopBar><h1>Session</h1><PluginTopBarActions context={make()} captureContext={() => { throw Error("Cannot capture current view"); }} /></TopBar>);
  try {
    await fixture.click(fixture.document.querySelector<HTMLElement>('[data-plugin-action="fixture/view"]')!);
    assert.equal(calls, 0); assert.match(fixture.owner.manager.getSnapshot().plugins[0]!.error!, /Cannot capture current view/);
    (data.composer as { text: string }).text = "disabled";
    await fixture.render(<TopBar><h1>Session</h1><PluginTopBarActions context={make()} /></TopBar>);
    assert.equal(fixture.document.querySelector<HTMLButtonElement>('[data-plugin-action="fixture/view"]')!.disabled, true);
  } finally { await fixture.close(); }
});

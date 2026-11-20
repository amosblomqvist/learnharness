import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { PluginProblemDockContent } from "../components/plugin-problem-dock.tsx";
import { PluginProblemSubmittedContent } from "../components/plugin-problem-submitted.tsx";
import { PluginSubmissionRunner } from "../components/plugin-submission-runner.ts";
import { capturePluginQuestionKey } from "../components/plugin-question-keys.ts";
import type { PluginProblemDraft } from "../components/session-core.ts";
import type { ProblemRendererRegistration } from "../components/plugin-manager.ts";
import type { PluginProblemSnapshot, PluginProblemEditorProps, PluginProblemRenderer, PluginProblemSubmission, PluginSubmissionTarget, PluginSurfaceTarget } from "../src/core/index.ts";
import type { PreparePluginProblemSubmission } from "../components/plugin-submission-adapters.ts";

const snapshot: PluginProblemSnapshot = { protocolVersion: 1, problemId: "problem-one", pluginId: "fixture", typeId: "code", label: "Coding problem", contractVersion: 1,
  input: { statement: "Public statement", mode: "composition", modelSolution: "PRIVATE_SOLUTION", payload: { starter: "initial code" } },
  problemSchema: { type: "object" }, submissionSchema: { type: "string" }, requiresSubmissionRefinement: false, requiresProcessing: true };
const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "code_problem" };
let cleanup: (() => Promise<void>) | undefined, restore: (() => void) | undefined;
afterEach(async () => { await cleanup?.(); restore?.(); cleanup = undefined; restore = undefined; });
async function dom() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  let active: Element = parsed.document.body;
  Object.defineProperty(parsed.document, "activeElement", { get: () => active });
  parsed.window.HTMLElement.prototype.focus = function () { active = this; };
  parsed.window.HTMLElement.prototype.blur = function () { if (active === this) active = parsed.document.body; };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ React, window: parsed.window, document: parsed.document, Node: parsed.window.Node, HTMLElement: parsed.window.HTMLElement,
    CustomEvent: parsed.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, navigator: { userAgent: "", platform: "" }, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => Response.json({ settings: { version: 1 } }),
  })) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  restore = () => { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; };
  const { createRoot } = await import("react-dom/client"), root = createRoot(document.getElementById("root")!);
  cleanup = async () => { await act(async () => { root.unmount(); }); };
  return async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };
}
async function fixture(options: { missing?: boolean; available?: boolean; ready?: boolean; prepare?: PreparePluginProblemSubmission } = {}) {
  const renderRoot = await dom();
  const draft: PluginProblemDraft = { submission: { status: "empty" }, thinking: "original thinking" };
  const state = { expanded: true, ready: options.ready ?? true, available: options.available ?? true, mounts: 0, disposals: 0, inputs: [] as unknown[], updates: [] as boolean[] };
  let editorProps!: PluginProblemEditorProps;
  let registration: ProblemRendererRegistration | undefined = options.missing ? undefined : { pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], mountSubmissionEditor(container, props) {
    state.mounts++; editorProps = props;
    const textarea = container.ownerDocument.createElement("textarea"); textarea.id = "code-editor"; textarea.value = "initial code";
    textarea.addEventListener("input", () => props.onChange({ status: "ready", value: textarea.value })); container.append(textarea);
    props.onChange({ status: "ready", value: "initial code" });
    return { update(value) { state.updates.push(value.active); }, focus() { textarea.focus(); }, dispose() { state.disposals++; } };
  } } };
  const prepare: PreparePluginProblemSubmission = options.prepare ?? (async (capture, valid, accepted) => { assert.equal(valid(), true); state.inputs.push(capture()); accepted(); return true; });
  const render = () => renderRoot(<PluginProblemDockContent snapshot={snapshot} occurrence={occurrence} chatId="chat" draft={draft} expanded={state.expanded} ready={state.ready} available={state.available} reconciliation="ready" registration={registration} onExpand={() => { state.expanded = true; }} prepareSubmission={prepare} send={async () => { throw Error("interceptors must not be bypassed"); }} />);
  await render();
  const submit = async () => { await act(async () => { (document.querySelector('[data-testid="practice-send"]') as HTMLElement).click(); }); };
  return { state, draft, render, submit, get editorProps() { return editorProps; }, replaceRegistration(next?: ProblemRendererRegistration) { registration = next; } };
}

/** Match Chat's real runner reservation -> asynchronous dictation -> capture seam.
 * A synchronous prepare stub cannot expose the reservation's parent re-render. */
async function preparingFixture() {
  const renderRoot = await dom();
  const draft: PluginProblemDraft = { submission: { status: "empty" }, thinking: "original thinking" };
  const state = { snapshot, ready: true, available: true, externalPreparing: false };
  const deliveries: unknown[] = [], errors: Error[] = [];
  const gates: { release(): void; done: Promise<void> }[] = [];
  let runner!: PluginSubmissionRunner;
  const registration: ProblemRendererRegistration = { pluginId: "fixture", renderer: {
    id: "code", supportedContractVersions: [1], mountSubmissionEditor(container, props) {
      const input = container.ownerDocument.createElement("textarea"); input.id = "prepared-code-editor"; input.value = "initial code";
      container.append(input); props.onChange({ status: "ready", value: input.value });
      return { update() {}, focus() { input.focus(); }, dispose() { input.remove(); } };
    },
  } };
  const target: PluginSubmissionTarget = { type: "plugin-problem-submission", sessionId: "chat", sessionKind: "practice", surfaceTarget: {} as PluginSurfaceTarget,
    channels: ["submission", "thinking"], problem: { problemId: snapshot.problemId, occurrence, pluginId: snapshot.pluginId, typeId: snapshot.typeId,
      contractVersion: snapshot.contractVersion, label: snapshot.label, statement: snapshot.input.statement } };
  function Harness() {
    const [, changed] = React.useState(0);
    const [owned] = React.useState(() => new PluginSubmissionRunner(() => changed(value => value + 1))); runner = owned;
    const prepare: PreparePluginProblemSubmission = async (capture, isCurrent, accepted) => {
      const attempt = owned.begin(target, [], isCurrent);
      if (!attempt) return false;
      let release!: () => void, finish!: () => void;
      const dictation = new Promise<void>(resolve => { release = resolve; });
      const done = new Promise<void>(resolve => { finish = resolve; }); gates.push({ release, done });
      try {
        const input = await attempt.finalize(async () => { await dictation; return capture(); });
        attempt.deliver(); deliveries.push(input); accepted(); attempt.accepted(); return true;
      } catch (error) { errors.push(error instanceof Error ? error : Error(String(error))); return false; }
      finally { attempt.refused(); finish(); }
    };
    return <PluginProblemDockContent snapshot={state.snapshot} occurrence={occurrence} chatId="chat" draft={draft} expanded ready={state.ready} available={state.available}
      reconciliation="ready" preparing={owned.occupied || state.externalPreparing} registration={registration} onExpand={() => {}} prepareSubmission={prepare}
      send={async () => { throw Error("Preparation cannot bypass the runner"); }} />;
  }
  const render = () => renderRoot(<Harness />);
  await render();
  const submit = async () => { await act(async () => { (document.querySelector('[data-testid="practice-send"]') as HTMLElement).click(); }); };
  const shortcut = async () => { await act(async () => { capturePluginQuestionKey({ key: "Enter", metaKey: true,
    target: document.querySelector("#prepared-code-editor"), preventDefault() {} } as unknown as KeyboardEvent); }); };
  const release = async (index = 0) => { const gate = gates[index]!; await act(async () => { gate.release(); await gate.done; }); };
  return { state, draft, deliveries, errors, gates, render, submit, shortcut, release, get runner() { return runner; } };
}

test("practice reservation survives its own preparing re-render, captures after dictation and blocks duplicate submits", async () => {
  const f = await preparingFixture();
  await f.submit();
  assert.equal(f.runner.occupied, true);
  assert.ok(document.querySelector('[data-testid="practice-send"]')!.hasAttribute("disabled"));
  await f.shortcut(); await f.submit();
  assert.equal(f.gates.length, 1, "No second preparation while the admitted attempt owns the runner");
  f.draft.thinking = "final dictation tail"; await f.render();
  await f.release();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.deliveries, [{ type: "plugin-problem-submission", problemId: snapshot.problemId, occurrence, submission: "initial code", thinking: "final dictation tail" }]);
  assert.deepEqual(f.draft.submission, { status: "ready", value: "initial code" });
  assert.equal(f.draft.thinking, "");
  assert.equal(f.runner.occupied, false);
  await f.submit(); await f.release(1);
  assert.equal(f.deliveries.length, 2, "The same practice problem permits another attempt after acceptance");
});

test("unrelated preparation blocks initial keyboard admission without losing code or thinking", async () => {
  const f = await preparingFixture(); f.state.externalPreparing = true; await f.render();
  await f.shortcut(); await f.submit();
  assert.equal(f.gates.length, 0);
  assert.deepEqual(f.draft.submission, { status: "ready", value: "initial code" });
  assert.equal(f.draft.thinking, "original thinking");
  f.state.externalPreparing = false; await f.render(); await f.submit(); await f.release();
  assert.equal(f.deliveries.length, 1);
});

for (const loss of ["problem", "ready", "available", "cancel"] as const) test(`practice preparation still refuses ${loss} authority loss and preserves draft channels`, async () => {
  const f = await preparingFixture(); await f.submit();
  if (loss === "problem") f.state.snapshot = { ...snapshot, problemId: "successor-problem" };
  else if (loss === "ready") f.state.ready = false;
  else if (loss === "available") f.state.available = false;
  else await act(async () => { f.runner.cancel(); });
  await f.render(); await f.release();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.draft.submission, { status: "ready", value: "initial code" });
  assert.equal(f.draft.thinking, "original thinking");
  assert.equal(f.runner.occupied, false);
});

test("practice dock orders statement/editor/thinking, submits separately and retains the editor value", async () => {
  const f = await fixture();
  const text = document.body.textContent ?? "";
  assert.match(text, /Public statement/); assert.doesNotMatch(text, /PRIVATE_SOLUTION/);
  const field = document.querySelector('[data-testid="practice-thinking-field"]')!;
  const elements = Array.from(document.querySelectorAll("*"));
  assert.ok(elements.indexOf(document.querySelector("#code-editor")!) < elements.indexOf(field));
  assert.equal(document.querySelector('[data-testid="practice-send"]')?.textContent?.trim(), "Submit");
  await f.submit();
  assert.deepEqual(f.state.inputs, [{ type: "plugin-problem-submission", problemId: "problem-one", occurrence, submission: "initial code", thinking: "original thinking" }]);
  assert.deepEqual(f.draft.submission, { status: "ready", value: "initial code" }); assert.equal(f.draft.thinking, "");
});

test("collapse and busy reconciliation preserve the current editor generation and structured draft", async () => {
  const f = await fixture(); assert.equal(f.state.mounts, 1);
  f.state.expanded = false; await f.render(); assert.equal(f.state.mounts, 1); assert.ok(document.querySelector("#code-editor"));
  assert.ok(document.querySelector('[data-testid="practice-dock-bar"]'));
  f.state.expanded = true; f.state.ready = false; await f.render(); assert.equal(f.state.mounts, 1); assert.equal(f.state.updates.at(-1), false);
  await f.submit(); assert.equal(f.state.inputs.length, 0);
  f.state.ready = true; await f.render(); await f.submit(); assert.equal(f.state.inputs.length, 1);
});

test("missing/disabled renderer leaves the plugin problem unavailable with no native editor fallback", async () => {
  const f = await fixture({ missing: true });
  assert.match(document.body.textContent ?? "", /Problem unavailable/); assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_SOLUTION/);
  assert.equal(document.querySelector("#code-editor"), null); assert.ok(document.querySelector('[data-testid="practice-send"]')?.hasAttribute("disabled"));
  await f.submit(); assert.equal(f.state.inputs.length, 0); assert.equal(f.draft.thinking, "original thinking");
});

test("late renderer publications cannot mutate a revoked generation's draft", async () => {
  const f = await fixture(), old = f.editorProps;
  f.state.available = false; f.replaceRegistration(); await f.render();
  assert.equal(old.signal.aborted, true); assert.equal(f.state.disposals, 1);
  await act(async () => { old.onChange({ status: "ready", value: "stale" }); });
  assert.deepEqual(f.draft.submission, { status: "ready", value: "initial code" });
});

test("unhandled editor Escape moves directly to thinking without submitting or discarding", async () => {
  const f = await fixture(); const textarea = document.querySelector("#code-editor") as HTMLElement; textarea.focus(); let claimed = false;
  await act(async () => { capturePluginQuestionKey({ key: "Escape", target: textarea, preventDefault() { claimed = true; } } as unknown as KeyboardEvent); });
  assert.equal(claimed, true); assert.equal(document.activeElement, document.querySelector('[data-testid="practice-thinking-field"] [data-file-path-input]'));
  assert.equal(f.state.inputs.length, 0); assert.equal(f.draft.thinking, "original thinking");
});

test("acceptance preserves thinking edited after capture", async () => {
  let accept!: () => void, captured: unknown;
  const f = await fixture({ prepare: async (capture, _valid, accepted) => { captured = capture(); accept = accepted; return true; } });
  await f.submit(); assert.ok(captured);
  f.draft.thinking = "newer thinking"; await f.render(); await act(async () => { accept(); });
  assert.equal(f.draft.thinking, "newer thinking");
});

test("submitted rendering owns generation-scoped header/body/footer slots and safely falls back without a renderer", async () => {
  const render = await dom(); const contexts: Parameters<NonNullable<PluginProblemRenderer["mountSubmitted"]>>[1][] = [];
  let cleaned = 0;
  const registration: ProblemRendererRegistration = { pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], mountSubmissionEditor() { throw Error("unused"); }, mountSubmitted(container, context) {
    contexts.push(context); container.textContent = "rendered code";
    const badge = container.ownerDocument.createElement("b"); badge.textContent = "Tests passed"; context.headerContainer?.append(badge);
    context.footerContainer!.textContent = "Test output";
    return () => { cleaned++; };
  } } };
  const data: PluginProblemSubmission = { kind: "plugin-problem-submission", problemId: snapshot.problemId, pluginId: snapshot.pluginId, typeId: snapshot.typeId,
    contractVersion: 1, submission: "saved code", thinking: "saved thinking", processing: { result: true }, submittedAt: "now" };
  await render(<PluginProblemSubmittedContent data={data} snapshot={snapshot} chatId="chat" registration={registration} />);
  assert.match(document.body.textContent ?? "", /Coding problemTests passed/); assert.match(document.body.textContent ?? "", /rendered code/);
  assert.deepEqual(contexts[0]?.processing, { result: true });
  const footer = contexts[0]!.footerContainer!;
  assert.equal(Object.isFrozen(footer), false);
  assert.equal(footer.parentElement, document.querySelector('[data-testid="plugin-problem-submitted"]')!.lastElementChild);
  const elements = Array.from(document.querySelectorAll("*"));
  assert.ok(elements.indexOf(document.querySelector('[data-testid="your-thinking"]')!) < elements.indexOf(footer));
  await render(<PluginProblemSubmittedContent data={data} snapshot={snapshot} chatId="chat" />);
  assert.equal(cleaned, 1); assert.equal(contexts[0]?.signal.aborted, true); assert.equal(contexts[0]?.headerContainer?.isConnected, false); assert.equal(footer.isConnected, false);
  await act(async () => { (document.querySelector('button[aria-expanded]') as HTMLElement).click(); });
  assert.match(document.body.textContent ?? "", /saved code/); assert.match(document.body.textContent ?? "", /saved thinking/);
  assert.doesNotMatch(document.body.textContent ?? "", /Tests passed|Test output|PRIVATE_SOLUTION/);
});

test("submitted footer isolates StrictMode replay, late cleanup, replacement and unmount generations", async () => {
  const render = await dom();
  const contexts: Parameters<NonNullable<PluginProblemRenderer["mountSubmitted"]>>[1][] = [];
  const complete: ((cleanup: () => void) => void)[] = [];
  let cleaned = 0;
  const registration: ProblemRendererRegistration = { pluginId: "fixture", renderer: {
    id: "code", supportedContractVersions: [1], mountSubmissionEditor() { throw Error("unused"); },
    mountSubmitted(container, context) {
      contexts.push(context); container.textContent = "code";
      context.footerContainer!.textContent = "footer " + contexts.length;
      return new Promise(resolve => { complete.push(resolve); });
    },
  } };
  const data: PluginProblemSubmission = { kind: "plugin-problem-submission", problemId: snapshot.problemId, pluginId: snapshot.pluginId, typeId: snapshot.typeId,
    contractVersion: 1, submission: "code", thinking: "retained thinking", submittedAt: "strict" };
  const view = (value: ProblemRendererRegistration) => <React.StrictMode><PluginProblemSubmittedContent data={data} snapshot={snapshot} chatId="chat" registration={value} /></React.StrictMode>;
  await render(view(registration));
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]!.signal.aborted, true);
  assert.equal(contexts[0]!.footerContainer!.isConnected, false);
  assert.notEqual(contexts[0]!.footerContainer, contexts[1]!.footerContainer);
  assert.equal(contexts[1]!.footerContainer!.isConnected, true);
  await act(async () => { complete[0]!(() => { cleaned++; }); });
  assert.equal(cleaned, 1);
  assert.match(document.body.textContent!, /footer 2/);
  const replacement: ProblemRendererRegistration = { ...registration, renderer: { ...registration.renderer,
    mountSubmitted(_container, context) { contexts.push(context); context.footerContainer!.textContent = "replacement footer"; return () => { cleaned++; }; },
  } };
  await render(view(replacement));
  assert.equal(contexts[1]!.signal.aborted, true);
  assert.equal(contexts[1]!.footerContainer!.isConnected, false);
  contexts[1]!.footerContainer!.textContent = "stale write";
  await act(async () => { complete[1]!(() => { cleaned++; }); });
  assert.equal(cleaned, 2);
  assert.match(document.body.textContent!, /replacement footer/);
  assert.doesNotMatch(document.body.textContent!, /stale write|footer 2|PRIVATE_SOLUTION/);
  await cleanup!(); cleanup = undefined;
  assert.equal(cleaned, 3);
  assert.equal(contexts[2]!.signal.aborted, true);
  assert.equal(contexts[2]!.footerContainer!.isConnected, false);
});

test("sync and async submitted mount failures remove partial footer content and preserve host thinking", async () => {
  const render = await dom();
  const data: PluginProblemSubmission = { kind: "plugin-problem-submission", problemId: snapshot.problemId, pluginId: snapshot.pluginId, typeId: snapshot.typeId,
    contractVersion: 1, submission: "saved code", thinking: "saved thinking", submittedAt: "failed" };
  for (const asyncFailure of [false, true]) {
    let context!: Parameters<NonNullable<PluginProblemRenderer["mountSubmitted"]>>[1];
    const registration: ProblemRendererRegistration = { pluginId: "fixture", renderer: {
      id: "code", supportedContractVersions: [1], mountSubmissionEditor() { throw Error("unused"); },
      mountSubmitted(container, value) {
        context = value; container.textContent = "partial code"; value.footerContainer!.textContent = "partial footer";
        if (asyncFailure) return Promise.reject(Error("fixture"));
        throw Error("fixture");
      },
    } };
    await render(<PluginProblemSubmittedContent data={data} snapshot={snapshot} chatId="chat" registration={registration} />);
    assert.equal(context.signal.aborted, true);
    assert.equal(context.footerContainer!.isConnected, false);
    assert.match(document.body.textContent!, /saved code|YOUR THINKING/);
    assert.doesNotMatch(document.body.textContent!, /partial footer|partial code|PRIVATE_SOLUTION/);
  }
});

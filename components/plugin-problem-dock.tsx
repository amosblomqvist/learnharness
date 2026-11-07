"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { clonePluginQuestionJson, freezePluginQuestionValue, pluginQuestionOccurrenceKey,
  type ChatInput, type PluginProblemSnapshot, type PluginProblemMountContext, type PluginSubmissionOccurrence } from "@/src/core";
import { PracticeDock } from "./practice-dock";
import type { PluginProblemDraft } from "./session-core";
import type { ProblemRendererRegistration } from "./plugin-manager";
import { createProblemEditorLease, type ProblemEditorLease } from "./plugin-question-editor";
import { ownPluginQuestionKeys } from "./plugin-question-keys";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { usePlugins } from "./plugins";
import { finishDictation } from "./dictation";
import type { PreparePluginProblemSubmission } from "./plugin-submission-adapters";

export function problemMountContext(snapshot: PluginProblemSnapshot, chatId: string, signal: AbortSignal): PluginProblemMountContext {
  return Object.freeze({ chatId, problemId: snapshot.problemId, contractVersion: snapshot.contractVersion,
    input: freezePluginQuestionValue(clonePluginQuestionJson(snapshot.input)) as unknown as PluginProblemSnapshot["input"], signal });
}
export interface PluginProblemDockProps {
  viewReader?: import("./session-view-readers").ViewReaderRef<{ available: boolean }>;
  snapshot: PluginProblemSnapshot; occurrence: PluginSubmissionOccurrence; chatId: string; draft: PluginProblemDraft;
  expanded: boolean; onExpand(): void; ready: boolean; available: boolean;
  reconciliation: "ready" | "syncing" | "failed";
  preparing?: boolean; compactionRunning?: boolean; onEscape?: () => void;
  prepareSubmission?: PreparePluginProblemSubmission;
  send(input: ChatInput): Promise<boolean>;
}
export function PluginProblemDock(props: PluginProblemDockProps) {
  const { snapshot } = usePlugins();
  const registration = snapshot.problemRenderers?.find(entry => entry.pluginId === props.snapshot.pluginId && entry.renderer.id === props.snapshot.typeId && entry.renderer.supportedContractVersions.includes(props.snapshot.contractVersion));
  return <PluginProblemDockContent {...props} registration={registration} />;
}
/** Native practice chrome with one alternative editor; no second problem lifecycle. */
export function PluginProblemDockContent(props: PluginProblemDockProps & { registration?: ProblemRendererRegistration }) {
  const { snapshot, occurrence, chatId, draft, expanded, ready, available, reconciliation, registration } = props;
  const controller = useOptionalInteractionLayers();
  const root = useRef<HTMLDivElement>(null), editor = useRef<HTMLDivElement>(null);
  const lease = useRef<ProblemEditorLease | null>(null), owner = useRef(registration);
  const key = `${snapshot.problemId}:${pluginQuestionOccurrenceKey(occurrence)}`, ownerKey = useRef(key);
  const current = useRef({ ...props, key }); current.current = { ...props, key };
  const [failed, setFailed] = useState(false), [submitting, setSubmitting] = useState(false);
  const [, render] = useReducer(value => value + 1, 0);
  const latch = useRef(false), thinkingRevision = useRef(0);
  useLayoutEffect(() => {
    if (!props.viewReader) return;
    const owner = props.viewReader, read = () => ({ available: current.current.available && !!current.current.registration && !failed });
    owner.current = read;
    return () => { if (owner.current === read) owner.current = null; };
  });
  useLayoutEffect(() => { props.viewReader?.changed?.(); }, [props.viewReader, draft.submission, draft.thinking, failed, available, registration]);
  const sameLease = !!lease.current && !!registration && owner.current === registration && ownerKey.current === key;
  const mountRegistration = ((reconciliation === "ready" && ready && available) || (sameLease && (reconciliation !== "ready" || available))) ? registration : undefined;
  useEffect(() => {
    setFailed(false);
    if (!mountRegistration || !editor.current) return;
    const container = editor.current.ownerDocument.createElement("div"); editor.current.append(container);
    const generation = createProblemEditorLease({
      props: { ...problemMountContext(snapshot, chatId, new AbortController().signal), submission: draft.submission,
        active: expanded && ready && reconciliation === "ready", onChange() {} },
      publish(value) { const now = current.current; if (now.key === key && now.registration === mountRegistration && now.available) draft.submission = value; },
      changed: render, failed: () => setFailed(true),
    });
    lease.current = generation; owner.current = mountRegistration; ownerKey.current = key;
    try { Promise.resolve(mountRegistration.renderer.mountSubmissionEditor(container, generation.props)).then(handle => generation.adopt(handle), () => generation.fail()); }
    catch { generation.fail(); }
    return () => { if (lease.current === generation) lease.current = null; generation.dispose(); container.remove(); };
  }, [key, chatId, mountRegistration]);
  useLayoutEffect(() => {
    if (lease.current && (owner.current !== registration || ownerKey.current !== key || !mountRegistration)) { lease.current.dispose(); lease.current = null; }
    lease.current?.update(draft.submission, expanded && ready && reconciliation === "ready" && available && !failed);
  });
  const submit = useCallback(async (readThinking?: () => string, clearThinking?: (captured: string) => void) => {
    const before = current.current, handle = lease.current;
    const valid = () => {
      const now = current.current;
      return now.key === before.key && lease.current === handle && !!handle?.ready && owner.current === now.registration && ownerKey.current === now.key &&
        now.ready && now.available && now.reconciliation === "ready" && now.expanded && !now.compactionRunning && !now.preparing && !!now.registration && !failed &&
        now.draft.submission.status === "ready" && isInteractionScopeEligible(root.current, controller);
    };
    if (latch.current || !valid()) return;
    latch.current = true; setSubmitting(true);
    let captured = "", revision = 0;
    const capture = (): Extract<ChatInput, { type: "plugin-problem-submission" }> => {
      const now = current.current;
      if (!valid() || now.draft.submission.status !== "ready") throw new Error("Problem is no longer ready");
      captured = readThinking ? readThinking() : now.draft.thinking; revision = thinkingRevision.current;
      return { type: "plugin-problem-submission", problemId: now.snapshot.problemId, occurrence: now.occurrence, submission: now.draft.submission.value, thinking: captured };
    };
    const accepted = () => {
      if (current.current.key === before.key && thinkingRevision.current === revision && before.draft.thinking === captured) {
        if (clearThinking) clearThinking(captured); else { before.draft.thinking = ""; render(); }
      }
    };
    try {
      if (before.prepareSubmission) await before.prepareSubmission(capture, valid, accepted);
      else { await finishDictation(); if (valid() && await before.send(capture())) accepted(); }
    } catch { /* Invalid/cancelled preparation preserves every draft channel. */ }
    finally { latch.current = false; setSubmitting(false); }
  }, [controller, failed]);
  const latestSubmit = useRef(submit); latestSubmit.current = submit;
  useEffect(() => ownPluginQuestionKeys({
    eligible: () => {
      const now = current.current;
      return now.ready && now.reconciliation === "ready" && now.expanded && now.available && !!lease.current?.mounted && owner.current === now.registration && ownerKey.current === now.key && isInteractionScopeEligible(root.current, controller);
    },
    contains: target => target instanceof Node && !!editor.current?.contains(target),
    key: key => lease.current?.key(key) ?? "pass",
    submit: () => { void latestSubmit.current(); },
    cycle() {
      const thinking = root.current?.querySelector<HTMLElement>('[data-testid="practice-thinking-field"] [data-file-path-input]');
      if (editor.current?.contains(document.activeElement)) thinking?.focus(); else lease.current?.focus();
    },
  }), [controller]);
  const canSubmit = ready && reconciliation === "ready" && available && !!registration && owner.current === registration && ownerKey.current === key && !failed && !!lease.current?.ready && draft.submission.status === "ready" && !submitting;
  const unavailable = reconciliation === "ready" && (!available || !registration || failed);
  return <div ref={root} data-testid="plugin-problem-dock">
    <PracticeDock problemCallId={occurrence.toolCallId} input={snapshot.input} expanded={expanded} onExpand={props.onExpand}
      onSubmit={() => {}} preparing={props.preparing || submitting || !ready} compactionRunning={props.compactionRunning} onEscape={props.onEscape}
      customInput={{ thinking: draft.thinking, onThinkingChange(value) { draft.thinking = value; thinkingRevision.current++; render(); }, ready: canSubmit,
        editor: <div className="px-4 py-2">
          {reconciliation === "syncing" && <p role="status" className="text-sm text-muted-foreground">Preparing problem…</p>}
          {unavailable && <p role="status" className="text-sm text-muted-foreground">Problem unavailable</p>}
          <div ref={editor} hidden={unavailable || failed} />
        </div>,
        prepare: (captureThinking, clearThinking) => { void latestSubmit.current(captureThinking, clearThinking); },
      }} />
  </div>;
}

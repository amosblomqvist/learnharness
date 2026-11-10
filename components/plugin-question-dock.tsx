"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";
import type { ChatInput } from "@/src/core";
import { pluginQuestionOccurrenceKey, type PluginQuestionSnapshot } from "@/src/core";
import type { PluginQuestionDraft } from "./session-core";
import type { QuestionRendererRegistration } from "./plugin-manager";
import { usePlugins } from "./plugins";
import { QuestionDockBar } from "./question-dock";
import { PathInput } from "./path-input";
import { finishDictation, joinDictation, usePluginQuestionDictationTarget } from "./dictation";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { useEnterSubmits } from "./enter-submits";
import { ownPluginQuestionKeys, composingQuestionKey, pluginQuestionKeySuppressed } from "./plugin-question-keys";
import { createQuestionEditorLease, type QuestionEditorLease } from "./plugin-question-editor";
import { PluginQuestionPresentation, questionMountContext } from "./plugin-question-slots";
import type { PreparePluginQuestionSubmission } from "./plugin-submission-adapters";
import { Button } from "./ui/button";

const keyOf = (snapshot: PluginQuestionSnapshot) => pluginQuestionOccurrenceKey(snapshot.occurrence);

interface PluginQuestionDockProps {
	viewReader?: import("./session-view-readers").ViewReaderRef<{ available: boolean }>;
	snapshot: PluginQuestionSnapshot; chatId: string; draft: PluginQuestionDraft; expanded: boolean; reveal: boolean; onExpand(): void;
	prepareSubmission?: PreparePluginQuestionSubmission;
	ready: boolean; reconciliation: "ready" | "syncing" | "failed"; available: boolean; readingRef: RefObject<HTMLDivElement | null>;
	onMicAvailable(available: boolean): void; send(input: ChatInput): Promise<boolean>; dismiss(): Promise<void>;
}
export function PluginQuestionDock(props: PluginQuestionDockProps) {
	const { snapshot: plugins } = usePlugins();
	const registration = plugins.questionRenderers?.find(entry => entry.pluginId === props.snapshot.pluginId && entry.renderer.id === props.snapshot.typeId && entry.renderer.supportedContractVersions.includes(props.snapshot.contractVersion));
	return <PluginQuestionDockContent {...props} registration={registration} />;
}

/** Host-only component seam for deterministic DOM/capture fixtures, not SDK. */
export function PluginQuestionDockContent({ viewReader, snapshot, chatId, draft, expanded, reveal, onExpand, ready, reconciliation, available, readingRef, onMicAvailable, send, dismiss, registration, prepareSubmission }: PluginQuestionDockProps & { registration?: QuestionRendererRegistration }) {
	const controller = useOptionalInteractionLayers();
	const root = useRef<HTMLDivElement>(null);
	const editor = useRef<HTMLDivElement>(null);
	const thinking = useRef<HTMLDivElement>(null);
	const lease = useRef<QuestionEditorLease | null>(null);
	const leaseRegistration = useRef(registration);
	const leaseKey = useRef(keyOf(snapshot));
	const [failed, setFailed] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [, render] = useReducer(n => n + 1, 0);
	const latch = useRef(false);
	const current = useRef({ snapshot, draft, expanded, reveal, ready, reconciliation, available, registration, failed });
	current.current = { snapshot, draft, expanded, reveal, ready, reconciliation, available, registration, failed };
	useLayoutEffect(() => {
		if (!viewReader) return;
		const read = () => { const now = current.current; return { available: now.available && !!now.registration && !now.failed }; };
		viewReader.current = read;
		return () => { if (viewReader.current === read) viewReader.current = null; };
	}, [viewReader]);
	useLayoutEffect(() => { viewReader?.changed?.(); }, [viewReader, draft.answer, draft.thinking, draft.readingThinking, failed, available, registration]);
	const key = pluginQuestionOccurrenceKey(snapshot.occurrence);
	const canonicalReady = reconciliation === "ready";
	// Unknown availability during reconciliation is not revocation. Retain
	// only an already-admitted generation with the same live registration;
	// new generations still require confirmed authority and interaction readiness.
	const sameLease = !!lease.current && !!registration && leaseRegistration.current === registration && leaseKey.current === key;
	const mountRegistration = !reveal && ((canonicalReady && ready && available) || (sameLease && (!canonicalReady || available))) ? registration : undefined;
	useEffect(() => {
		setFailed(false);
		if (!mountRegistration || !editor.current) return;
		const container = editor.current.ownerDocument.createElement("div");
		editor.current.append(container);
		const generation = createQuestionEditorLease({
			props: { ...questionMountContext(snapshot, chatId, new AbortController().signal), answer: draft.answer, active: expanded && canonicalReady && ready && !reveal, onChange() {} },
			publish: answer => { const now = current.current; if (now.registration === registration && keyOf(now.snapshot) === key && now.available) draft.answer = answer; }, changed: render, failed: () => setFailed(true),
		});
		lease.current = generation;
		leaseRegistration.current = registration;
		leaseKey.current = key;
		try { Promise.resolve(mountRegistration.renderer.mountAnswerEditor(container, generation.props)).then(handle => generation.adopt(handle), () => generation.fail()); }
		catch { generation.fail(); }
		return () => { if (lease.current === generation) lease.current = null; generation.dispose(); container.remove(); };
	}, [key, chatId, mountRegistration]);
	useLayoutEffect(() => {
		if (lease.current && (leaseRegistration.current !== registration || leaseKey.current !== key || !mountRegistration)) { lease.current.dispose(); lease.current = null; }
		lease.current?.update(draft.answer, expanded && canonicalReady && ready && !reveal && !failed);
	});

	const submit = useCallback(async () => {
		const before = current.current;
		const handle = lease.current;
		if (latch.current || before.reconciliation !== "ready" || !before.ready || !before.expanded || before.reveal || !before.available || !before.registration || leaseRegistration.current !== before.registration || leaseKey.current !== keyOf(before.snapshot) || before.failed || !handle?.ready || !isInteractionScopeEligible(root.current, controller)) return;
		latch.current = true; setSubmitting(true);
		try {
			const valid = () => {
				const now = current.current;
				return lease.current === handle && handle.ready && keyOf(now.snapshot) === keyOf(before.snapshot) && now.snapshot.questionId === before.snapshot.questionId && now.reconciliation === "ready" && now.ready && now.expanded && !now.reveal && now.available && !!now.registration && leaseRegistration.current === now.registration && leaseKey.current === keyOf(now.snapshot) && !now.failed && isInteractionScopeEligible(root.current, controller) && now.draft.answer.status === "ready";
			};
			const capture = (): Extract<ChatInput, { type: "plugin-question-answer" }> => {
				const now = current.current;
				if (!valid() || now.draft.answer.status !== "ready") throw new Error("Question is no longer ready");
				return { type: "plugin-question-answer", questionId: now.snapshot.questionId, occurrence: now.snapshot.occurrence, answer: now.draft.answer.value,
					...(now.snapshot.showThinking ? { thinking: now.draft.thinking } : {}),
					...(now.snapshot.variant === "teach" && now.snapshot.input.type === "check" ? { readingThinking: now.draft.readingThinking } : {}),
				};
			};
			if (prepareSubmission) await prepareSubmission(capture, valid);
			else { await finishDictation(); if (valid()) await send(capture()); }
		} catch { /* Failed transcript delivery must never submit a stale answer. */ }
		finally { latch.current = false; setSubmitting(false); }
	}, [controller, send, prepareSubmission]);
	const latestSubmit = useRef(submit); latestSubmit.current = submit;
	useEnterSubmits(() => { void latestSubmit.current(); }, root);
	useEffect(() => ownPluginQuestionKeys({
		eligible: key => current.current.expanded && !current.current.reveal && current.current.reconciliation === "ready" && current.current.ready && isInteractionScopeEligible(root.current, controller)
			&& (key !== "Escape" || (current.current.available && !current.current.failed && !!current.current.registration && leaseRegistration.current === current.current.registration && leaseKey.current === keyOf(current.current.snapshot) && !!lease.current?.mounted && isInteractionScopeEligible(editor.current, controller))),
		contains: target => target instanceof Node && !!editor.current?.contains(target),
		key: key => current.current.registration && leaseRegistration.current === current.current.registration && leaseKey.current === keyOf(current.current.snapshot) ? lease.current?.key(key) ?? "pass" : "pass",
		submit: () => { void latestSubmit.current(); },
		cycle: key => {
			const active = document.activeElement;
			const hasReading = current.current.snapshot.variant === "teach" && current.current.snapshot.input.type === "check";
			const chain = [
				...(hasReading && readingRef.current ? [{ contains: () => readingRef.current === active || !!readingRef.current?.contains(active), focus: () => readingRef.current?.focus() }] : []),
				...(current.current.registration && leaseRegistration.current === current.current.registration && leaseKey.current === keyOf(current.current.snapshot) && lease.current?.mounted ? [{ contains: () => !!editor.current?.contains(active), focus: () => lease.current?.focus() }] : []),
				...(current.current.snapshot.showThinking && thinking.current ? [{ contains: () => thinking.current === active || !!thinking.current?.contains(active), focus: () => thinking.current?.focus() }] : []),
			];
			if (!chain.length) return;
			// Escape leaves the focused editor on this event. A one-field
			// chain must blur instead of wrapping straight back into the editor.
			if (key === "Escape" && chain.length === 1) { if (active instanceof HTMLElement) active.blur(); return; }
			const index = chain.findIndex(field => field.contains()); chain[(index + 1) % chain.length]!.focus();
		},
	}), [controller, readingRef]);

	const speechLease = snapshot.showThinking ? null : lease.current;
	const append = useCallback(async (text: string) => {
		const now = current.current;
		if (now.reveal || keyOf(now.snapshot) !== key) return; // Reading owns the unrevealed phase.
		// Host thinking is a draft channel, not plugin execution authority:
		// an already-captured final must survive reconciliation or compaction.
		if (snapshot.showThinking) { draft.thinking = joinDictation(draft.thinking, text); render(); }
		else if (!failed && speechLease === lease.current && now.registration && leaseRegistration.current === now.registration && now.available) await speechLease?.append(text);
	}, [key, snapshot.showThinking, speechLease, reveal, failed, draft]);
	usePluginQuestionDictationTarget(append, !reveal);
	const micAvailable = reveal || snapshot.showThinking || (!!registration && leaseRegistration.current === registration && !!lease.current?.speech && available && !failed);
	useEffect(() => { onMicAvailable(micAvailable); return () => onMicAvailable(false); }, [micAvailable, onMicAvailable]);
	const unavailable = canonicalReady && (!available || !registration || failed);
	const canSubmit = canonicalReady && ready && available && !!registration && leaseRegistration.current === registration && leaseKey.current === key && !failed && !!lease.current?.ready && draft.answer.status === "ready" && !submitting;
	return <div ref={root} data-testid="plugin-question-dock">
		{!expanded && <QuestionDockBar toolName="explain" question={snapshot.input.question} toolLabel={snapshot.label} variant={reveal ? "reveal" : "collapsed"} onExpand={() => { void finishDictation().then(onExpand); }} />}
		<div className={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
			<div className="space-y-3 px-4 py-3">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{snapshot.input.type === "predict" ? "Prediction" : snapshot.label}</div>
				<PluginQuestionPresentation snapshot={snapshot} chatId={chatId} registration={mountRegistration} failed={() => { setFailed(true); lease.current?.dispose(); }} />
				{reconciliation === "syncing" && <p role="status" className="text-sm text-muted-foreground">Preparing question…</p>}
				{unavailable && <p role="status" className="text-sm text-muted-foreground">Question unavailable</p>}
				<div ref={editor} className={unavailable || failed ? "hidden" : "min-w-0"} />
			</div>
			{/* Plugin DOM is intentionally outside the footer's native form. */}
			<form onSubmit={event => { event.preventDefault(); void submit(); }} className="border-t border-border/60 p-1.5">
				<div data-testid={snapshot.showThinking ? "thinking-field" : undefined}
					className={snapshot.showThinking ? "rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50" : undefined}>
					{snapshot.showThinking && <>
						<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Your thinking</div>
						<PathInput ref={thinking} value={draft.thinking} onValueChange={value => { draft.thinking = value; render(); }} onKeyDown={event => {
							if (composingQuestionKey(event) || pluginQuestionKeySuppressed(event)) return;
							if (!isInteractionScopeEligible(event.currentTarget, controller)) return;
							if (event.key === "Enter" && !event.altKey && (!event.shiftKey || event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
						}} className="field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70" placeholder="Your thinking" />
					</>}
					<div className="flex items-center justify-between gap-2 p-1">
						<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">↵ submits · ⇧↵ newline</span>
						{unavailable && <Button type="button" variant="ghost" disabled={!ready || submitting} onClick={() => { if (latch.current) return; latch.current = true; void finishDictation().then(dismiss).catch(() => {}).finally(() => { latch.current = false; }); }}>Dismiss question</Button>}
						<Button type="submit" disabled={!canSubmit} className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium">Submit answer</Button>
					</div>
				</div>
			</form>
		</div>
	</div>;
}

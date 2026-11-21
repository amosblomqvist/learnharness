"use client";

/**
 * Adaptive question layout as a hook (Appearance → Adapt question layout):
 * the pending question card and the answered card in the transcript both
 * solve with it, so the two always agree.
 *
 * Two stages. MEASURE (once per question and reading font, on off-screen
 * clones, after rich content settled): everything that depends only on the
 * content — column minimums, diagram widths, 70ch, the trigger. DECIDE (on
 * every width change — window, sidebar, transcript setting): arithmetic over
 * those numbers and the columns' height curves, never a DOM read, so a
 * resize never forces layout. Never on typing; a content version bumped only
 * when rich content changes height at an unchanged width (late diagrams,
 * images, fonts) measures again.
 */

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
	createProbeHost,
	measureQuestionLayout,
	onFontsLoaded,
	questionContentFingerprint,
	questionContentReady,
	solveMeasured,
	type QuestionLayout,
	type QuestionMeasure,
	type QuestionParts,
} from "@/components/question-layout";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Adaptive layout inputs (px; null = adaptation off). */
export interface QuestionLayoutRequest {
	/** Maximum card inner width: the transcript width less chrome. */
	available: number;
	/** The default card inner width (46rem container less chrome). */
	base: number;
	/** Column floor (23rem). */
	floor: number;
	/** Font identity (family + size): a change re-measures. */
	key: string;
}

export function sameLayout(a: QuestionLayout | null, b: QuestionLayout | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind === "stacked" || b.kind === "stacked") return a.kind === b.kind && a.width === b.width;
	return a.question === b.question && a.answer === b.answer;
}

/** Measurements per question, card kind and reading font — never per
 *  width — so reopening a session or scrolling back to an answered card
 *  never measures again, and a resize only decides. */
type Measured = { measure: QuestionMeasure; content: string };
const measured = new Map<string, Measured>();
const MEASURED_MAX = 256;
function remember(key: string, entry: Measured) {
	measured.delete(key);
	measured.set(key, entry);
	if (measured.size > MEASURED_MAX) measured.delete(measured.keys().next().value!);
}

/** The LIVE rendered question: what content readiness, the fingerprint and
 *  late-content detection read. */
export interface LiveQuestion {
	root: HTMLElement;
	/** Label + question + context (may be display: contents). */
	question: HTMLElement;
	options: HTMLElement | null;
	/** Boxes whose height change at an unchanged width is late content. */
	observe: (HTMLElement | null)[];
}

export interface UseQuestionLayout {
	/** Cache identity, unique per question and card kind. */
	cacheId: string;
	/** null = adaptation off (or not yet near the screen). */
	request: QuestionLayoutRequest | null;
	/** Reset identity: a different question re-solves. */
	identity: unknown;
	live: () => LiveQuestion | null;
	/** The parts measured (default: the live parts + confidence). */
	parts: (live: LiveQuestion) => QuestionParts;
	onLayout?: (layout: QuestionLayout | null) => void;
	/** Called just BEFORE the arrangement changes (columns ⇄ stacked; null
	 *  lays out stacked), while the DOM still shows the old one. */
	onSwitch?: (from: QuestionLayout | null, to: QuestionLayout | null) => void;
}

const arrangement = (l: QuestionLayout | null) => (l?.kind === "columns" ? "columns" : "stacked");

export function useQuestionLayout({ cacheId, request, identity, live, parts, onLayout, onSwitch }: UseQuestionLayout): QuestionLayout | null {
	const [layout, setLayout] = useState<QuestionLayout | null>(null);
	const [contentVersion, bumpContent] = useReducer((n: number) => n + 1, 0);
	const onLayoutRef = useRef(onLayout);
	onLayoutRef.current = onLayout;
	const onSwitchRef = useRef(onSwitch);
	onSwitchRef.current = onSwitch;
	const liveRef = useRef(live);
	liveRef.current = live;
	const partsRef = useRef(parts);
	partsRef.current = parts;
	const layoutRef = useRef<QuestionLayout | null>(null);
	// A content bump (diagram, image, font, late styles) means the content
	// changed since the last solve: measure again, never reuse.
	const seenVersionRef = useRef(contentVersion);
	const staleRef = useRef(false);
	const hostRef = useRef<HTMLElement | null>(null);
	// A measurement waits for rich content/fonts: whatever settles it
	// (fonts finishing — even with nothing new or a failure — a diagram, an
	// image) must bring the solve back.
	const deferredRef = useRef(false);
	const enabled = !!request;
	useIsoLayoutEffect(() => {
		let next: QuestionLayout | null = null;
		const now = liveRef.current();
		if (request && now) {
			const key = `${cacheId}|${request.base}|${request.floor}|${request.key}`;
			if (contentVersion !== seenVersionRef.current) {
				seenVersionRef.current = contentVersion;
				staleRef.current = true;
			}
			const host = () => {
				if (!hostRef.current || hostRef.current.parentNode !== now.root) hostRef.current = createProbeHost(now.root);
				return hostRef.current;
			};
			const content = questionContentFingerprint(now);
			const known = measured.get(key);
			if (!staleRef.current && known && known.content === content) {
				// DECIDE: arithmetic over the saved measurements.
				deferredRef.current = false;
				next = solveMeasured(known.measure, request);
			} else if (!questionContentReady(now)) {
				// Not settled yet: the settling signal brings us back. Until
				// then the CURRENT budget still rules — the previous
				// measurements decide for it, and without any, a layout
				// that no longer fits falls back to stacked.
				deferredRef.current = true;
				const current = layoutRef.current;
				if (known) next = solveMeasured(known.measure, request);
				else if (current && current.kind === "columns" && current.width > request.available + 0.5) {
					next = { kind: "stacked", width: Math.max(request.base, Math.min(current.width, request.available)), binding: true };
				} else return;
			} else {
				deferredRef.current = false;
				const result = measureQuestionLayout(partsRef.current(now), request, host());
				next = result.layout;
				staleRef.current = false;
				remember(key, { measure: result.measure, content });
			}
		}
		if (sameLayout(layoutRef.current, next)) return;
		if (arrangement(layoutRef.current) !== arrangement(next)) onSwitchRef.current?.(layoutRef.current, next);
		layoutRef.current = next;
		// Same commit for both: a caller's width and the columns land together.
		setLayout(next);
		onLayoutRef.current?.(next);
		// The request's fields (not its identity) are the inputs.
	}, [identity, cacheId, enabled, request?.available, request?.base, request?.floor, request?.key, contentVersion]);
	useEffect(() => () => {
		onLayoutRef.current?.(null);
		hostRef.current?.remove();
		hostRef.current = null;
	}, []);
	// Late content: a height change at an UNCHANGED width is content (our
	// own width changes always move the width and are ignored).
	useEffect(() => {
		if (!enabled) return;
		const now = liveRef.current();
		if (!now) return;
		const seen = new Map<Element, { w: number; h: number }>();
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => { frame = 0; bumpContent(); });
		};
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width: w, height: h } = entry.contentRect;
				const last = seen.get(entry.target);
				seen.set(entry.target, { w, h });
				if (last && Math.abs(last.w - w) < 0.5 && Math.abs(last.h - h) > 0.5) schedule();
			}
		});
		for (const el of now.observe) if (el) ro.observe(el);
		const fonts = typeof document !== "undefined" ? document.fonts : undefined;
		const offFonts = onFontsLoaded(fonts, schedule);
		// Readiness, distinct from invalidation: a deferred solve retries
		// when fonts stop loading, whether or not anything new loaded.
		let alive = true;
		const onFontsSettled = () => { if (alive && deferredRef.current && fonts?.status !== "loading") schedule(); };
		fonts?.addEventListener?.("loadingdone", onFontsSettled);
		fonts?.addEventListener?.("loadingerror", onFontsSettled);
		void fonts?.ready?.then(onFontsSettled, onFontsSettled);
		// Images with fixed sizes finish loading without changing height.
		const root = now.root;
		const onLoad = (e: Event) => { if ((e.target as Element | null)?.tagName === "IMG") schedule(); };
		root.addEventListener("load", onLoad, true);
		root.addEventListener("error", onLoad, true);
		return () => {
			alive = false;
			ro.disconnect();
			offFonts();
			fonts?.removeEventListener?.("loadingdone", onFontsSettled);
			fonts?.removeEventListener?.("loadingerror", onFontsSettled);
			root.removeEventListener("load", onLoad, true);
			root.removeEventListener("error", onLoad, true);
			if (frame) cancelAnimationFrame(frame);
		};
		// A layout switch keeps the subtree, but observe again so a caller
		// whose boxes did change is followed too.
	}, [enabled, identity, layout?.kind]);
	return layout;
}

"use client";

import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface DockHeightMeasurements {
	columnHeight: number;
	/** Stats/toolbar and block padding, outside the scrolling viewport. */
	outsideHeight: number;
	/** Everything in the viewport except the animated shell. */
	beforeShellHeight: number;
	shellBorderHeight: number;
	/** Natural content height, not the shell's animated/clamped height. */
	contentHeight: number;
	/** Null when collapsed, in chat mode, or showing malformed input. */
	questionHeight: number | null;
	/** The region's height that is not scrollable content (regionChrome). */
	questionPaddingHeight: number;
	/** The least content a clipped scroll area must still show (owner:
	 *  about three lines of text); below it the whole content scrolls. */
	questionMinContentHeight?: number;
	/** The question's UNCAPPED height (its scroll areas' hidden overflow
	 *  added back); defaults to questionHeight. */
	questionNaturalHeight?: number;
}

/** Owner (session-appearance-layout): a scroll area showing fewer than about
 *  three lines is useless — the whole question card scrolls instead,
 *  "Your thinking" included, in stacked and two-column cards alike. */
export const MIN_VISIBLE_LINES = 3;

export function dockHeightBudget(m: DockHeightMeasurements) {
	const available = Math.max(m.columnHeight - 32, 0);
	const viewportMaxHeight = Math.max(available - m.outsideHeight, 0);
	const shellMaxHeight = Math.max(viewportMaxHeight - m.beforeShellHeight, 0);
	const naturalHeight = m.beforeShellHeight + m.shellBorderHeight + m.contentHeight;
	const questionMaxHeight = m.questionHeight === null
		? null
		: Math.max(viewportMaxHeight - (naturalHeight - m.questionHeight), 0);
	// A cap that would clip the question down to less than a usable content
	// viewport (its padding plus about three lines) is useless: deliberately
	// uncap the question and scroll the whole content instead. A question
	// that fits under its cap is never affected. Do not confuse a measured
	// zero with an unmeasured CSS fallback.
	const scrollWholeContent = questionMaxHeight === null
		? naturalHeight > viewportMaxHeight
		: questionMaxHeight <= m.questionPaddingHeight
			|| (questionMaxHeight < (m.questionNaturalHeight ?? m.questionHeight!) - 0.5
				&& questionMaxHeight < m.questionPaddingHeight + (m.questionMinContentHeight ?? 0));
	return { viewportMaxHeight, shellMaxHeight, questionMaxHeight, scrollWholeContent };
}

interface DockHeightElements {
	column: HTMLElement;
	block: HTMLElement;
	viewport: HTMLElement;
	body: HTMLElement;
	shell: HTMLElement;
	content: HTMLElement;
}

const pixels = (value: string) => Number.parseFloat(value) || 0;

const SCROLL_AREA = "[data-dock-scroll-area]";

function edges(el: Element): number {
	const cs = getComputedStyle(el);
	return pixels(cs.paddingTop) + pixels(cs.paddingBottom) + pixels(cs.borderTopWidth) + pixels(cs.borderBottomWidth);
}

/** About MIN_VISIBLE_LINES lines of the region's reading text, in px. */
export function minContentHeight(region: HTMLElement): number {
	const prose = region.querySelector(".lh-prose") ?? region;
	const cs = getComputedStyle(prose);
	const line = pixels(cs.lineHeight) || pixels(cs.fontSize) * 1.5;
	return MIN_VISIBLE_LINES * line;
}

/** The region's height without the current cap: a capped scroll area hides
 *  the rest of its content as overflow. */
export function naturalRegionHeight(region: HTMLElement, height: number): number {
	let hidden = 0;
	const areas = region.matches(SCROLL_AREA) ? [region] : [...region.querySelectorAll<HTMLElement>(SCROLL_AREA)];
	for (const area of areas) hidden = Math.max(hidden, area.scrollHeight - area.clientHeight);
	return height + hidden;
}

/** The part of the height region that is never scrollable content: a single
 * scroll area's own padding, or — two columns, whose row has no padding —
 * the costliest column's: its scroller's padding plus everything around the
 * scroller inside the column (wrapper padding, rows pinned beside it). A cap
 * at or below this leaves some scroller no content viewport at all. */
export function regionChrome(region: HTMLElement): number {
	if (region.matches(SCROLL_AREA)) return edges(region);
	let chrome = 0;
	for (const scroller of region.querySelectorAll<HTMLElement>(SCROLL_AREA)) {
		let fixed = edges(scroller);
		for (let el: HTMLElement = scroller; el.parentElement && el.parentElement !== region; el = el.parentElement) {
			const parent = el.parentElement;
			fixed += edges(parent);
			for (const sibling of parent.children) if (sibling !== el) fixed += sibling.getBoundingClientRect().height;
		}
		chrome = Math.max(chrome, fixed);
	}
	return chrome + edges(region);
}

/** The dock's height-variable region: a two-column question's column row
 * (both columns cap at --dock-max-h and scroll on their own) or, first in
 * document order otherwise, the single question/problem scroll area. */
export const DOCK_HEIGHT_REGION = "[data-dock-height-region], [data-dock-scroll-area]";

/** Read natural geometry before writing any constraints. Cancel the shell's
 * animated height out of both ancestor measurements, then substitute its
 * natural content and borders. This stays valid during a WAAPI height morph
 * and when the outer viewport is already capped. */
export function syncDockHeight(elements: DockHeightElements, expanded: boolean) {
	const { column, block, viewport, body, shell, content } = elements;
	// QuestionDock keeps a laid-out form in an invisible h-0 wrapper;
	// PracticeDock removes its form. Neither hidden form is a height input.
	const question = expanded ? content.querySelector<HTMLElement>(DOCK_HEIGHT_REGION) : null;
	const height = (el: HTMLElement) => el.getBoundingClientRect().height;
	const shellStyle = getComputedStyle(shell);
	const budget = dockHeightBudget({
		columnHeight: column.clientHeight,
		outsideHeight: Math.max(height(block) - height(viewport), 0),
		beforeShellHeight: Math.max(height(body) - height(shell), 0),
		shellBorderHeight: pixels(shellStyle.borderTopWidth) + pixels(shellStyle.borderBottomWidth),
		contentHeight: height(content),
		questionHeight: question ? height(question) : null,
		questionPaddingHeight: question ? regionChrome(question) : 0,
		questionMinContentHeight: question ? minContentHeight(question) : 0,
		...(question ? { questionNaturalHeight: naturalRegionHeight(question, height(question)) } : {}),
	});
	if (budget.questionMaxHeight === null) block.style.removeProperty("--dock-max-h");
	else block.style.setProperty("--dock-max-h", budget.scrollWholeContent ? "none" : `${budget.questionMaxHeight}px`);
	viewport.style.maxHeight = `${budget.viewportMaxHeight}px`;
	// Overflow is visible in normal layouts: keep the shell's shadow intact.
	// The stats/model toolbar is a sibling, never inside this overflow box.
	viewport.style.overflowY = budget.scrollWholeContent ? "auto" : "visible";
	// Clamp animated starting heights too, so a previous tall variant cannot
	// paint above the column while morphing into a constrained layout.
	shell.style.maxHeight = budget.scrollWholeContent ? "none" : `${budget.shellMaxHeight}px`;
	return budget;
}

interface DockHeightRefs {
	scrollRef: RefObject<HTMLElement | null>;
	blockRef: RefObject<HTMLDivElement | null>;
	viewportRef: RefObject<HTMLDivElement | null>;
	bodyRef: RefObject<HTMLDivElement | null>;
	shellRef: RefObject<HTMLDivElement | null>;
	contentRef: RefObject<HTMLDivElement | null>;
}

export function useDockHeight({
	scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef,
	expanded, enabled, mode, onScrollbarInset, onHeight, onLayout,
}: DockHeightRefs & {
	expanded: boolean;
	enabled: boolean;
	/** Reconnect observers when the keyed content node/scroll area changes. */
	mode: string;
	onScrollbarInset: (inset: number) => void;
	/** Settled visible block height, fed through the existing reserve policy. */
	onHeight: (height: number) => void;
	/** Constraints are applied before notifying an active opening morph. */
	onLayout?: () => void;
}) {
	const measure = useCallback(() => {
		const column = scrollRef.current;
		const block = blockRef.current;
		const viewport = viewportRef.current;
		const body = bodyRef.current;
		const shell = shellRef.current;
		const content = contentRef.current;
		if (!column || !block || !viewport || !body || !shell || !content) return;
		onScrollbarInset(Math.round((column.offsetWidth - column.clientWidth) / 2));
		if (enabled) syncDockHeight({ column, block, viewport, body, shell, content }, expanded);
		else {
			block.style.removeProperty("--dock-max-h");
			viewport.style.removeProperty("max-height");
			viewport.style.removeProperty("overflow-y");
			shell.style.removeProperty("max-height");
		}
		onLayout?.();
		// ResizeObserver runs even when only a child field changed and React
		// did not rerender DockOverlay. Keep its transcript reserve current,
		// but never report a mid-morph height.
		if (shell.getAnimations().length === 0) onHeight(block.getBoundingClientRect().height);
	}, [scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef, expanded, enabled, onScrollbarInset, onHeight, onLayout]);

	// Imperative constraints land before the overlay's later layout effect
	// measures its morph target/reserve, and before paint (including reveal).
	useIsoLayoutEffect(measure);
	useIsoLayoutEffect(() => {
		// Ignore already-queued deliveries after variant replacement or Activity
		// cleanup: old observers must never retarget a newer height animation.
		let active = true;
		const observedMeasure = () => { if (active) measure(); };
		const observer = new ResizeObserver(observedMeasure);
		for (const el of [scrollRef.current, blockRef.current, viewportRef.current, bodyRef.current, contentRef.current]) {
			if (el) observer.observe(el);
		}
		const question = expanded ? contentRef.current?.querySelector(DOCK_HEIGHT_REGION) : null;
		if (question) observer.observe(question);
		window.addEventListener("resize", observedMeasure);
		return () => {
			active = false;
			observer.disconnect();
			window.removeEventListener("resize", observedMeasure);
		};
	}, [measure, mode, expanded, scrollRef, blockRef, viewportRef, bodyRef, contentRef]);
}

/** Overlay and transcript are siblings. Keep native scrolling in an actual
 * scroll container (including the short-window viewport), then forward only
 * at its edge. overflow:hidden/visible boxes cannot consume the wheel. */
export function forwardDockWheel(event: WheelEvent, root: HTMLElement, transcript: HTMLElement) {
	if (event.deltaY === 0) return;
	for (let n = event.target as HTMLElement | null; n && n !== root; n = n.parentElement) {
		if (!(n instanceof HTMLElement) || !/^(auto|scroll)$/.test(getComputedStyle(n).overflowY)) continue;
		if (n.scrollHeight - n.clientHeight < 2) continue;
		if (event.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop < n.scrollHeight - n.clientHeight - 0.5) return;
	}
	event.preventDefault();
	transcript.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? transcript.clientHeight : 1);
}

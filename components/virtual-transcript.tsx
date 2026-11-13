"use client";

import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { estimateTranscriptRow, type TranscriptRow } from "./transcript-rows";
import { TranscriptRowState } from "./transcript-row-state";
import { TRANSCRIPT_OVERSCAN, transcriptJumpWindow, transcriptJumpRestoreOffset, transcriptJumpTravel, type TranscriptJumpWindow } from "./transcript-jump";
import { transcriptWindow } from "./transcript-window";

const TranscriptRowBody = memo(function TranscriptRowBody({ row, state, render }: {
	row: TranscriptRow; state: Map<string, unknown>; render: (row: TranscriptRow) => ReactNode;
}) {
	return <TranscriptRowState.Provider value={state}>{render(row)}</TranscriptRowState.Provider>;
});

interface TranscriptJump extends TranscriptJumpWindow {
	id: number;
	phase: "prepare" | "animate" | "settle";
	from: number;
}

export interface VirtualTranscriptHandle {
	revealRow(index: number): Promise<HTMLElement | null>;
	revealMessage(id: string): Promise<HTMLElement | null>;
	scrollToBottom(): Promise<void>;
}

export function VirtualTranscript({ rows, handleRef, children }: {
	rows: readonly TranscriptRow[];
	handleRef: RefObject<VirtualTranscriptHandle | null>;
	children: (row: TranscriptRow) => ReactNode;
}) {
	const context = useStickToBottomContext();
	const contextRef = useRef(context);
	contextRef.current = context;
	const root = useRef<HTMLDivElement>(null);
	const rowStates = useRef(new Map<string, Map<string, unknown>>());
	const stateForRow = (key: string) => {
		let state = rowStates.current.get(key);
		if (!state) { state = new Map(); rowStates.current.set(key, state); }
		return state;
	};
	const [pinned, setPinned] = useState<number | null>(null);
	const [interactionRows, setInteractionRows] = useState<readonly number[]>([]);
	const [scrollMargin, setScrollMargin] = useState(16);
	const [width, setWidth] = useState(900);
	const [jump, setJump] = useState<TranscriptJump | null>(null);
	const jumpRef = useRef(jump);
	const jumpSequence = useRef(0);
	const jumpGeometry = useRef({ shift: 0, tailStart: 0 });
	const jumpFrame = useRef<number | null>(null);
	const virtualizerRef = useRef<Virtualizer<HTMLElement, Element> | null>(null);
	const cancelJumpRef = useRef<() => void>(() => {});
	const estimates = useMemo(() => rows.map(row => estimateTranscriptRow(row, width)), [rows, width]);
	const estimatedTotal = useMemo(() => estimates.reduce((total, height) => total + height, 0), [estimates]);
	const getScrollElement = useCallback(() => context.scrollRef.current, [context.scrollRef]);
	const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
	const estimateSize = useCallback((index: number) => estimates[index]!, [estimates]);
	const rangeExtractor = useCallback((range: Range) => {
		const instance = virtualizerRef.current;
		const indexes = new Set(jump ? [] : transcriptWindow(range, instance?.measurementsCache ?? [], instance?.scrollRect?.height ?? 900));
		if (jump) {
			for (let index = jump.sourceStart; index <= jump.sourceEnd && index < rows.length; index++) indexes.add(index);
			for (let index = jump.tailStart; index < rows.length; index++) indexes.add(index);
		}
		for (const index of [...interactionRows, ...(pinned === null ? [] : [pinned])]) if (index < rows.length) indexes.add(index);
		return [...indexes].sort((a, b) => a - b);
	}, [jump, interactionRows, pinned, rows.length]);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement, getItemKey, estimateSize,
		overscan: TRANSCRIPT_OVERSCAN,
		scrollMargin,
		initialRect: { width: 900, height: 900 },
		initialOffset: Math.max(0, estimatedTotal - 900),
		rangeExtractor,
	});
	virtualizerRef.current = virtualizer;
	const items = virtualizer.getVirtualItems();
	const sourceEnd = jump ? items.find(item => item.index === jump.sourceEnd) : undefined;
	const tailStart = jump ? items.find(item => item.index === jump.tailStart) : undefined;
	const shift = jump?.phase === "animate" && sourceEnd && tailStart ? Math.max(0, tailStart.start - sourceEnd.end) : 0;
	jumpGeometry.current = { shift, tailStart: tailStart?.start ?? 0 };
	const updateJumpPositions = useCallback(() => {
		const active = jumpRef.current;
		const offset = jumpGeometry.current.shift;
		const scroll = contextRef.current;
		const travel = active?.phase === "animate" ? transcriptJumpTravel(scroll.state.scrollTop, active.from, scroll.state.targetScrollTop, offset) : 0;
		for (const row of root.current?.children ?? []) {
			const element = row as HTMLElement;
			const index = Number(element.dataset.transcriptRow);
			element.style.translate = active?.phase === "animate" ? `0 ${index >= active.tailStart ? travel - offset : travel}px` : "";
		}
		const column = root.current?.parentElement;
		column?.style.setProperty("--transcript-jump-offset", `${offset - travel}px`);
	}, []);
	useLayoutEffect(() => { updateJumpPositions(); });
	// StickToBottom remains the sole owner of following the live tail. A size
	// correction above a reader should preserve that reader's current passage.
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
		!contextRef.current.isAtBottom && item.end < (instance.scrollOffset ?? 0);

	useLayoutEffect(() => {
		const scroll = context.scrollRef.current;
		if (!scroll || !root.current) return;
		setScrollMargin(root.current.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
		let previous = scroll.clientWidth;
		const observer = new ResizeObserver(() => {
			if (previous !== scroll.clientWidth) { cancelJumpRef.current(); previous = scroll.clientWidth; }
			setWidth(scroll.clientWidth);
		});
		observer.observe(scroll);
		setWidth(scroll.clientWidth);
		return () => observer.disconnect();
	}, [context.scrollRef]);
	const previousWidth = useRef(width);
	useLayoutEffect(() => {
		if (previousWidth.current === width) return;
		previousWidth.current = width;
		const scroll = context.scrollRef.current;
		const atBottom = contextRef.current.isAtBottom;
		const anchor = virtualizer.getVirtualItems().find(item => item.end > (scroll?.scrollTop ?? 0));
		const within = scroll && anchor ? scroll.scrollTop - anchor.start : 0;
		// Measurements made at a different wrapping width cannot be reused.
		virtualizer.measure();
		if (scroll && anchor && !atBottom) {
			const offset = virtualizer.getOffsetForIndex(anchor.index, "start");
			if (offset) scroll.scrollTop = offset[0] + within;
		}
	}, [width, virtualizer, context.scrollRef]);

	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (jumpRef.current) contextRef.current.stopScroll();
			if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
			root.current?.parentElement?.style.removeProperty("--transcript-jump-offset");
		};
	}, []);
	const finishJump = useCallback((completed: boolean) => {
		const active = jumpRef.current;
		if (!active || active.phase === "settle") return;
		const scroll = contextRef.current;
		const travel = active.phase === "animate" ? transcriptJumpTravel(scroll.state.scrollTop, active.from, scroll.state.targetScrollTop, jumpGeometry.current.shift) : 0;
		const top = completed ? scroll.state.targetScrollTop : transcriptJumpRestoreOffset(scroll.state.scrollTop - travel, jumpGeometry.current.tailStart, jumpGeometry.current.shift);
		scroll.stopScroll();
		if (jumpFrame.current !== null) { cancelAnimationFrame(jumpFrame.current); jumpFrame.current = null; }
		const settling: TranscriptJump = { ...active, phase: "settle" };
		jumpRef.current = settling;
		// Restore real row coordinates and scroll offset in one frame. Keep
		// both windows mounted until the virtualizer has observed that offset.
		flushSync(() => setJump(settling));
		scroll.state.scrollTop = top;
		if (completed) void scroll.scrollToBottom({ animation: "instant" });
		requestAnimationFrame(() => {
			if (mounted.current && jumpRef.current?.id === active.id) { jumpRef.current = null; setJump(null); }
		});
	}, []);
	cancelJumpRef.current = () => finishJump(false);
	const scrollToBottom = useCallback(async () => {
		if (jumpRef.current) return;
		const scroll = contextRef.current;
		const element = scroll.scrollRef.current;
		if (!element) return;
		const window = transcriptJumpWindow(virtualizer.getVirtualItems(), element.scrollTop, element.clientHeight,
			scroll.state.targetScrollTop, rows.length, index => virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0);
		if (!window) { await scroll.scrollToBottom(); return; }
		scroll.stopScroll();
		const preparing: TranscriptJump = { ...window, id: ++jumpSequence.current, phase: "prepare", from: element.scrollTop };
		jumpRef.current = preparing;
		flushSync(() => setJump(preparing));
		// The destination's actual DOM is measured before the animation starts.
		await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		if (!mounted.current || jumpRef.current !== preparing) return;
		const animating: TranscriptJump = { ...preparing, phase: "animate" };
		jumpRef.current = animating;
		flushSync(() => setJump(animating));
		const completion = scroll.scrollToBottom();
		// StickToBottom queues its scroll write first. Project the two windows
		// immediately afterwards in the same frame, before the browser paints.
		const frame = () => {
			if (!mounted.current || jumpRef.current?.phase !== "animate") return;
			updateJumpPositions();
			jumpFrame.current = requestAnimationFrame(frame);
		};
		jumpFrame.current = requestAnimationFrame(frame);
		const completed = await completion;
		if (mounted.current && jumpRef.current?.id === preparing.id) finishJump(completed);
	}, [virtualizer, rows.length, finishJump, updateJumpPositions]);
	const revealRow = useCallback(async (index: number): Promise<HTMLElement | null> => {
		if (index < 0 || index >= rows.length) return null;
		cancelJumpRef.current();
		contextRef.current.stopScroll();
		setPinned(index);
		virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
		// React must commit the requested window before links/Find read a Range.
		for (let frame = 0; frame < 30 && mounted.current; frame++) {
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			const element = root.current?.querySelector<HTMLElement>(`[data-transcript-row="${index}"]`);
			if (element) return element;
		}
		return null;
	}, [rows, virtualizer]);
	useImperativeHandle(handleRef, () => ({ revealRow, scrollToBottom,
		revealMessage: id => revealRow(rows.findIndex(row => row.sourceIds.includes(id))),
	}), [revealRow, rows, scrollToBottom]);

	// An explicitly revealed row is retained only until the next user scroll.
	// Focused controls and text selections must not disappear mid-interaction.
	useEffect(() => {
		const scroll = context.scrollRef.current;
		if (!scroll) return;
		const release = () => { cancelJumpRef.current(); setPinned(null); };
		const retain = () => {
			const selection = document.getSelection();
			const indexOf = (element: Element | null | undefined) => {
				const row = element?.closest<HTMLElement>("[data-transcript-row]");
				return row && root.current?.contains(row) ? Number(row.dataset.transcriptRow) : null;
			};
			const indexes: number[] = [];
			const focused = indexOf(document.activeElement);
			if (focused !== null) indexes.push(focused);
			if (selection && !selection.isCollapsed) {
				const start = indexOf(selection.anchorNode?.parentElement), end = indexOf(selection.focusNode?.parentElement);
				if (start !== null && end !== null) for (let index = Math.min(start, end); index <= Math.max(start, end); index++) indexes.push(index);
			}
			setInteractionRows(previous => previous.length === indexes.length && previous.every((index, at) => index === indexes[at]) ? previous : indexes);
		};
		scroll.addEventListener("wheel", release, { passive: true });
		scroll.addEventListener("touchstart", release, { passive: true });
		document.addEventListener("selectionchange", retain);
		scroll.addEventListener("focusin", retain);
		scroll.addEventListener("focusout", retain);
		return () => {
			scroll.removeEventListener("wheel", release);
			scroll.removeEventListener("touchstart", release);
			document.removeEventListener("selectionchange", retain);
			scroll.removeEventListener("focusin", retain);
			scroll.removeEventListener("focusout", retain);
		};
	}, [context.scrollRef]);

	return <div ref={root} data-virtual-transcript="" data-row-count={rows.length} data-transcript-jump={shift ? "" : undefined} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%", overflowAnchor: "none" }}>
		{items.map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-transcript-row={item.index} data-session-find-root=""
			className="flex min-w-0 flex-col gap-4"
			style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - scrollMargin}px)`, paddingBottom: rows[item.index]!.gapAfter }}>
			<TranscriptRowBody row={rows[item.index]!} state={stateForRow(rows[item.index]!.key)} render={children} />
		</div>)}
	</div>;
}

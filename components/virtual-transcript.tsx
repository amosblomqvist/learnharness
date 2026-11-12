"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { estimateTranscriptRow, type TranscriptRow } from "./transcript-rows";
import { TranscriptRowState } from "./transcript-row-state";

export interface VirtualTranscriptHandle {
	revealRow(index: number): Promise<HTMLElement | null>;
	revealMessage(id: string): Promise<HTMLElement | null>;
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
	const estimates = useMemo(() => rows.map(row => estimateTranscriptRow(row, width)), [rows, width]);
	const estimatedTotal = useMemo(() => estimates.reduce((total, height) => total + height, 0), [estimates]);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => context.scrollRef.current,
		getItemKey: index => rows[index]!.key,
		estimateSize: index => estimates[index]!,
		overscan: 3,
		scrollMargin,
		initialRect: { width: 900, height: 900 },
		initialOffset: Math.max(0, estimatedTotal - 900),
		rangeExtractor: range => {
			const indexes = new Set(defaultRangeExtractor(range));
			for (const index of [...interactionRows, ...(pinned === null ? [] : [pinned])]) if (index < rows.length) indexes.add(index);
			return [...indexes].sort((a, b) => a - b);
		},
	});
	// StickToBottom remains the sole owner of following the live tail. A size
	// correction above a reader should preserve that reader's current passage.
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
		!contextRef.current.isAtBottom && item.end < (instance.scrollOffset ?? 0);

	useLayoutEffect(() => {
		const scroll = context.scrollRef.current;
		if (!scroll || !root.current) return;
		setScrollMargin(root.current.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
		const observer = new ResizeObserver(() => setWidth(scroll.clientWidth));
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
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const revealRow = useCallback(async (index: number): Promise<HTMLElement | null> => {
		if (index < 0 || index >= rows.length) return null;
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
	useImperativeHandle(handleRef, () => ({ revealRow,
		revealMessage: id => revealRow(rows.findIndex(row => row.sourceIds.includes(id))),
	}), [revealRow, rows]);

	// An explicitly revealed row is retained only until the next user scroll.
	// Focused controls and text selections must not disappear mid-interaction.
	useEffect(() => {
		const scroll = context.scrollRef.current;
		if (!scroll) return;
		const release = () => setPinned(null);
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

	return <div ref={root} data-virtual-transcript="" data-row-count={rows.length} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%", overflowAnchor: "none" }}>
		{virtualizer.getVirtualItems().map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-transcript-row={item.index} data-session-find-root=""
			className="flex min-w-0 flex-col gap-4"
			style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - scrollMargin}px)`, paddingBottom: rows[item.index]!.gapAfter }}>
			<TranscriptRowState.Provider value={stateForRow(rows[item.index]!.key)}>{children(rows[item.index]!)}</TranscriptRowState.Provider>
		</div>)}
	</div>;
}

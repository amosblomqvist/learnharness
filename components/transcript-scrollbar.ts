"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { observeElementOffset, type Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import type { StickToBottomContext } from "use-stick-to-bottom";

interface DragRange { height: number; maxOffset: number; padding: number }
type TranscriptVirtualizer = Virtualizer<HTMLElement, Element>;

/** Keep the native track fixed during a thumb gesture while measurements
 * refine the logical history underneath it. No DOM scroll writes are needed. */
export function transcriptScrollbarOffset(physicalOffset: number, physicalMax: number, logicalMax: number): number {
	return physicalMax > 0 ? Math.max(0, Math.min(1, physicalOffset / physicalMax)) * Math.max(0, logicalMax) : 0;
}

export function useTranscriptScrollbar({ contextRef, virtualizerRef, root, cancelJumpRef, unpin }: {
	contextRef: RefObject<StickToBottomContext>;
	virtualizerRef: RefObject<TranscriptVirtualizer | null>;
	root: RefObject<HTMLDivElement | null>;
	cancelJumpRef: RefObject<() => void>;
	unpin: (value: null) => void;
}) {
	const dragRef = useRef<DragRange | null>(null);
	const [drag, setDrag] = useState<DragRange | null>(null);
	const notifyOffset = useRef<(() => void) | null>(null);
	const logicalOffset = useCallback((physicalOffset: number) => {
		const active = dragRef.current, instance = virtualizerRef.current;
		const scroll = contextRef.current.scrollRef.current;
		if (!active || !instance || !scroll) return physicalOffset;
		return transcriptScrollbarOffset(physicalOffset, active.maxOffset,
			instance.getTotalSize() + active.padding - scroll.clientHeight);
	}, [contextRef, virtualizerRef]);
	const observeOffset = useCallback<NonNullable<VirtualizerOptions<HTMLElement, Element>["observeElementOffset"]>>((instance, callback) => {
		const notify = () => callback(logicalOffset(instance.scrollElement?.scrollTop ?? 0), false);
		notifyOffset.current = notify;
		const cleanup = observeElementOffset(instance, (offset, scrolling) => callback(logicalOffset(offset), scrolling));
		return () => {
			cleanup?.();
			if (notifyOffset.current === notify) notifyOffset.current = null;
		};
	}, [logicalOffset]);
	// A measured size can change the mapping without a native scroll event.
	// Notify at normal priority: this effect already runs before paint.
	useLayoutEffect(() => {
		const scroll = contextRef.current.scrollRef.current, instance = virtualizerRef.current;
		if (dragRef.current && scroll && instance && Math.abs(logicalOffset(scroll.scrollTop) - (instance.scrollOffset ?? 0)) > 0.5) notifyOffset.current?.();
	});
	const scrollRef = contextRef.current.scrollRef;
	useEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		const start = (event: PointerEvent) => {
			// Native scrollbar events target the scroller, including overlay
			// scrollbars without a gutter. Row controls target descendants.
			if (event.button !== 0 || event.target !== scroll || !root.current) return;
			cancelJumpRef.current();
			contextRef.current.stopScroll();
			unpin(null);
			const height = virtualizerRef.current?.getTotalSize() ?? root.current.offsetHeight;
			const range = { height, maxOffset: scroll.scrollHeight - scroll.clientHeight, padding: scroll.scrollHeight - height };
			dragRef.current = range;
			flushSync(() => setDrag(range));
		};
		const end = () => {
			if (!dragRef.current) return;
			const offset = logicalOffset(scroll.scrollTop);
			dragRef.current = null;
			// Drop the projection and restore its logical offset together, so
			// releasing the thumb preserves the currently visible passage.
			flushSync(() => setDrag(null));
			contextRef.current.state.scrollTop = offset;
		};
		scroll.addEventListener("pointerdown", start, true);
		document.addEventListener("pointerup", end, true);
		document.addEventListener("pointercancel", end, true);
		window.addEventListener("blur", end);
		window.addEventListener("resize", end);
		return () => {
			scroll.removeEventListener("pointerdown", start, true);
			document.removeEventListener("pointerup", end, true);
			document.removeEventListener("pointercancel", end, true);
			window.removeEventListener("blur", end);
			window.removeEventListener("resize", end);
			dragRef.current = null;
		};
	}, [scrollRef, root, cancelJumpRef, contextRef, virtualizerRef, unpin, logicalOffset]);
	return { drag, dragRef, observeOffset,
		contentOffset: () => {
			const offset = contextRef.current.scrollRef.current?.scrollTop ?? 0;
			return dragRef.current ? offset - logicalOffset(offset) : 0;
		},
	};
}

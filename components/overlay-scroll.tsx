"use client";

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { cn } from "@/lib/utils";

/** How long the bar stays after the last scroll, before fading. */
const LINGER_MS = 900;
const MIN_THUMB = 24;

/**
 * A scroller whose bar OVERLAYS its content instead of reserving a gutter
 * (owner, sidebar polish round): rows, rules and highlights run to the right
 * edge. The bar is thin and draggable, shown only while scrolling or while
 * the pointer is over the area, then fades. Native wheel/keyboard/touch
 * scrolling are untouched; only the native bar is hidden.
 */
export function OverlayScrollArea({ scrollRef, areaClassName, className, children, ...props }: HTMLAttributes<HTMLDivElement> & {
	scrollRef?: RefObject<HTMLDivElement | null>;
	/** Classes for the positioned area around the scroller (margins). */
	areaClassName?: string;
}) {
	const ownRef = useRef<HTMLDivElement | null>(null);
	const ref = scrollRef ?? ownRef;
	const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
	const [hovered, setHovered] = useState(false);
	const [scrolling, setScrolling] = useState(false);
	const [dragging, setDragging] = useState(false);
	const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
	const drag = useRef<{ pointerY: number; scrollTop: number } | null>(null);

	const measure = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const { scrollHeight, clientHeight, scrollTop } = el;
		if (scrollHeight <= clientHeight + 1) { setThumb(null); return; }
		const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight);
		const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
		setThumb((previous) => previous && previous.top === top && previous.height === height ? previous : { top, height });
	}, [ref]);

	// Content and size changes (folders opening, rows arriving, window resize).
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const resize = new ResizeObserver(measure);
		const observeChildren = () => {
			resize.disconnect();
			resize.observe(el);
			for (const child of Array.from(el.children)) resize.observe(child);
		};
		observeChildren();
		const mutations = new MutationObserver(() => { observeChildren(); measure(); });
		mutations.observe(el, { childList: true, subtree: true });
		measure();
		return () => { resize.disconnect(); mutations.disconnect(); };
	}, [ref, measure]);

	useEffect(() => () => { if (linger.current) clearTimeout(linger.current); }, []);

	const onScroll = () => {
		measure();
		setScrolling(true);
		if (linger.current) clearTimeout(linger.current);
		linger.current = setTimeout(() => setScrolling(false), LINGER_MS);
	};

	const onThumbDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const el = ref.current;
		if (!el || event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { pointerY: event.clientY, scrollTop: el.scrollTop };
		setDragging(true);
	};
	const onThumbMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const el = ref.current;
		if (!el || !drag.current || !thumb) return;
		const track = el.clientHeight - thumb.height;
		if (track <= 0) return;
		el.scrollTop = drag.current.scrollTop + ((event.clientY - drag.current.pointerY) / track) * (el.scrollHeight - el.clientHeight);
	};
	const onThumbUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		drag.current = null;
		setDragging(false);
	};

	const visible = thumb !== null && (hovered || scrolling || dragging);
	return (
		<div className={cn("relative flex min-h-0 flex-1 flex-col", areaClassName)} onPointerEnter={() => { measure(); setHovered(true); }} onPointerLeave={() => setHovered(false)}>
			<div {...props} ref={ref} onScroll={onScroll} className={cn("lh-overlay-scroll min-h-0 flex-1 overflow-y-auto", className)}>
				{children}
			</div>
			{thumb && (
				<div aria-hidden="true" data-testid="overlay-scroll-thumb" data-visible={visible}
					onPointerDown={onThumbDown} onPointerMove={onThumbMove} onPointerUp={onThumbUp} onPointerCancel={onThumbUp}
					className={cn("absolute right-0.5 z-10 w-1.5 rounded-full bg-border transition-opacity duration-300 hover:bg-muted-foreground",
						dragging && "bg-muted-foreground", visible ? "opacity-100" : "pointer-events-none opacity-0")}
					style={{ top: thumb.top, height: thumb.height }} />
			)}
		</div>
	);
}

"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GripVerticalIcon, MinusIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The floating card's header: a drag grip plus the minimize control. The HOST
 * owns the panel position — this header only reports the panel's clamped
 * absolute top-left. Every drag and the first keyboard nudge seed from the
 * real panel rect (closest('[data-testid="dock-float-panel"]'), falling back
 * to the grip's own rect); later moves and arrows chain from the last
 * emitted point, which is newer than the panel's rect until it catches up.
 * Only a DOM with no readable geometry anywhere seeds from the {8, 8} clamp
 * floor. A press on a button never drags; Escape minimizes and is claimed so
 * the underlying question is not dismissed; arrows with modifier keys fall
 * through.
 */

const EDGE = 8;
const SLIVER_X = 96;
const SLIVER_Y = 48;
const KEY_STEP = 16;
/** Last resort when no element reports usable geometry: the clamp floor. */
const SEED = { x: EDGE, y: EDGE };

/** Clamp an absolute panel origin so a usable part stays inside the
 *  viewport. `panelWidth` defaults to the 96px grab sliver for hosts that
 *  did not report a size; hosts owning the panel pass its real offsetWidth
 *  so a narrow phone keeps the whole card on-screen (never page overflow). */
export function clampFloat(x: number, y: number, panelWidth?: number, panelHeight?: number): { x: number; y: number } {
	const width = typeof window === "undefined" ? Infinity : window.innerWidth;
	const height = typeof window === "undefined" ? Infinity : window.innerHeight;
	const maxX = Math.max(EDGE, width - Math.min(panelWidth ?? SLIVER_X, width - 2 * EDGE));
	const maxY = Math.max(EDGE, height - Math.min(panelHeight ?? SLIVER_Y, height - 2 * EDGE));
	return {
		x: Math.min(Math.max(x, EDGE), maxX),
		y: Math.min(Math.max(y, EDGE), maxY),
	};
}

export function FloatGrip({
	label,
	onFloatPosition,
	onMinimize,
	className,
}: {
	/** The kind eyebrow (Check / Explain / Question / Practice / Prediction). */
	label: ReactNode;
	/** Emits the panel's clamped absolute top-left on drag/keys. Absent = no drag math. */
	onFloatPosition?: (x: number, y: number) => void;
	/** Minimize to the chip; absent hides the button. */
	onMinimize?: () => void;
	className?: string;
}) {
	// The last emitted top-left; null until the first emission.
	const posRef = useRef<{ x: number; y: number } | null>(null);
	const gripRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ pointerId: number; baseX: number; baseY: number; originX: number; originY: number } | null>(null);

	// The last emitted top-left wins over the panel rect: the host may not have
	// painted it yet. The panel rect (then the grip's) is the cold-start seed;
	// layout-less DOMs report zero rects, so only those reach the clamp floor.
	const panelRect = () => {
		const grip = gripRef.current;
		if (!grip) return null;
		const panel = grip.closest('[data-testid="dock-float-panel"]');
		const rect = panel?.getBoundingClientRect();
		if (rect && rect.width > 0) return { x: rect.left, y: rect.top };
		const own = grip.getBoundingClientRect();
		if (own.width > 0) return { x: own.left, y: own.top };
		return null;
	};

	const panelSize = () => {
		const grip = gripRef.current;
		const panel = grip?.closest<HTMLElement>('[data-testid="dock-float-panel"]');
		return panel ? { width: panel.offsetWidth, height: panel.offsetHeight } : undefined;
	};
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!onFloatPosition || !e.isPrimary || e.button !== 0) return;
		const target = e.target as Element | null;
		if (target && typeof target.closest === "function" && target.closest("button")) return;
		const start = posRef.current ?? panelRect() ?? SEED;
		dragRef.current = { pointerId: e.pointerId, baseX: e.clientX, baseY: e.clientY, originX: start.x, originY: start.y };
		e.preventDefault();
		try {
			gripRef.current?.setPointerCapture?.(e.pointerId);
		} catch {
			// Capture is best-effort; the window listeners keep the drag alive.
		}
	};

	useEffect(() => {
		const grip = gripRef.current;
		if (!onFloatPosition || !grip) return;
		const move = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== e.pointerId) return;
			const next = clampFloat(drag.originX + (e.clientX - drag.baseX), drag.originY + (e.clientY - drag.baseY), panelSize()?.width, panelSize()?.height);
			posRef.current = next;
			onFloatPosition(next.x, next.y);
		};
		const end = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== e.pointerId) return;
			dragRef.current = null;
			try {
				grip.releasePointerCapture?.(e.pointerId);
			} catch {
				// Already released or never captured.
			}
		};
		window.addEventListener("pointermove", move, { passive: true });
		window.addEventListener("pointerup", end, { passive: true });
		window.addEventListener("pointercancel", end, { passive: true });
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
		};
	}, [onFloatPosition]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			if (!onMinimize) return;
			e.preventDefault();
			e.stopPropagation();
			onMinimize();
			return;
		}
		if (!onFloatPosition || !e.key.startsWith("Arrow")) return;
		if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
		// The arrow belongs to the move, not to the quiz's option walk.
		e.preventDefault();
		e.stopPropagation();
		const base = posRef.current ?? panelRect() ?? SEED;
		const size = panelSize();
		const next = e.key === "ArrowLeft" ? clampFloat(base.x - KEY_STEP, base.y, size?.width, size?.height)
			: e.key === "ArrowRight" ? clampFloat(base.x + KEY_STEP, base.y, size?.width, size?.height)
			: e.key === "ArrowUp" ? clampFloat(base.x, base.y - KEY_STEP, size?.width, size?.height)
			: clampFloat(base.x, base.y + KEY_STEP, size?.width, size?.height);
		posRef.current = next;
		onFloatPosition(next.x, next.y);
	};

	return (
		<div
			ref={gripRef}
			data-testid="dock-float-grip"
			role="toolbar"
			tabIndex={0}
			aria-label="Question card. Drag to move; use arrow keys; Escape minimizes."
			style={{ touchAction: "none" }}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			className={cn(
				"flex select-none items-center gap-2 border-b bg-card/95 px-3 py-2",
				onFloatPosition && "cursor-grab active:cursor-grabbing",
				onFloatPosition ? "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" : "cursor-default",
				className,
			)}
		>
			{onFloatPosition && <GripVerticalIcon className="size-4 shrink-0 text-muted-foreground/70" />}
			<span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
			{onMinimize && (
				<button
					type="button"
					data-testid="dock-float-minimize"
					aria-label="Minimize question card"
					onClick={onMinimize}
					onPointerDown={(e) => e.stopPropagation()}
					className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary [@media(pointer:coarse)]:size-11"
				>
					<MinusIcon className="size-4" />
				</button>
			)}
		</div>
	);
}

/**
 * Where the side thread's popover sits (Addendum 2026-10-31), pure for
 * tests. `/btw` threads take the composer's exact width, right above it;
 * selection threads open by the passage and flip to the roomier side as
 * their content grows. A dragged popover stays where it was dropped,
 * clamped inside the window.
 */

import { computeMenuPlacement } from "./menu-shell";

type Rect = { left: number; right: number; top: number; bottom: number };
type Viewport = { width: number; height: number };

/** 26rem, the popover's width beside a passage. */
export const SIDE_THREAD_WIDTH = 416;
const EDGE = 8;
const GAP = 8;
const CAP_VH = 0.6;

export interface SideThreadPlacement {
	style: { left: number; width: number; top?: number; bottom?: number };
	maxHeight: number;
}

export function placeSideThread({ kind, rect, viewport, contentHeight }: {
	kind: "composer" | "rect";
	rect: Rect;
	viewport: Viewport;
	contentHeight: number;
}): SideThreadPlacement {
	if (kind === "composer") {
		return {
			style: { left: rect.left, width: rect.right - rect.left, bottom: viewport.height - rect.top + GAP },
			maxHeight: Math.min(CAP_VH * viewport.height, rect.top - GAP - EDGE),
		};
	}
	const width = Math.min(SIDE_THREAD_WIDTH, viewport.width - 2 * EDGE);
	const placed = computeMenuPlacement(rect, viewport, contentHeight, "down", "right");
	const right = (placed.style.right as number | undefined) ?? 0;
	const left = Math.max(EDGE, Math.min(viewport.width - right - width, viewport.width - width - EDGE));
	return {
		style: {
			left,
			width,
			...(placed.side === "down" ? { top: placed.style.top as number } : { bottom: placed.style.bottom as number }),
		},
		maxHeight: placed.maxHeight,
	};
}

export function clampDragged(at: { x: number; y: number }, size: { width: number; height: number }, viewport: Viewport): { x: number; y: number } {
	return {
		x: Math.max(EDGE, Math.min(at.x, viewport.width - size.width - EDGE)),
		y: Math.max(EDGE, Math.min(at.y, viewport.height - size.height - EDGE)),
	};
}

/** The smallest height the bottom-edge resize allows. */
export const SIDE_THREAD_MIN_HEIGHT = 160;

/** Bottom-edge resize: the start height plus the pointer's travel, kept
 *  between the minimum and the window's bottom edge. */
export function resizedHeight(startHeight: number, travel: number, top: number, viewportHeight: number): number {
	return Math.max(SIDE_THREAD_MIN_HEIGHT, Math.min(startHeight + travel, viewportHeight - top - EDGE));
}

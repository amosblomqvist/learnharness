/** Anchored, dragged, and resized floating companion geometry. Only the
 * macOS native-controls corner is excluded; ordinary browser placement
 * and the rest of the desktop's top edge remain available. */
import { computeMenuPlacement } from "./menu-shell";

type Rect = { left: number; right: number; top: number; bottom: number };
export type SideThreadViewport = {
	width: number; height: number;
	/** CSS-coordinate dimensions, already divided by Electron's zoom. */
	trafficLights?: { width: number; height: number };
};

/** 26rem, the popover's width beside a passage. */
export const SIDE_THREAD_WIDTH = 416;
const EDGE = 8;
const GAP = 8;
const CAP_VH = 0.6;

export interface SideThreadPlacement {
	style: { left: number; width: number; top?: number; bottom?: number };
	maxHeight: number;
}

/** A full-width panel cannot sit beside the native controls, so leave
 * enough vertical room to fit below them, even after a window shrink. */
function fitHeight(height: number, width: number, viewport: SideThreadViewport): number {
	const corner = viewport.trafficLights;
	const top = corner && width > viewport.width - corner.width - EDGE ? Math.max(EDGE, corner.height) : EDGE;
	return Math.max(0, Math.min(height, viewport.height - top - EDGE));
}

export function clampDragged(at: { x: number; y: number }, size: { width: number; height: number }, viewport: SideThreadViewport): { x: number; y: number } {
	const maxX = Math.max(EDGE, viewport.width - size.width - EDGE);
	const maxY = Math.max(EDGE, viewport.height - size.height - EDGE);
	let x = Math.max(EDGE, Math.min(at.x, maxX));
	let y = Math.max(EDGE, Math.min(at.y, maxY));
	const corner = viewport.trafficLights;
	if (corner && x < corner.width && y < corner.height) {
		// The closest valid edge wins; never reserve an entire top strip.
		const canRight = corner.width <= maxX;
		const canBelow = corner.height <= maxY;
		if (canRight && (!canBelow || corner.width - x < corner.height - y)) x = corner.width;
		else if (canBelow) y = corner.height;
	}
	return { x, y };
}

export function fitSideThreadFrame(frame: { x: number; y: number; height: number }, width: number, viewport: SideThreadViewport): { x: number; y: number; height: number } {
	const height = fitHeight(frame.height, width, viewport);
	return { ...clampDragged(frame, { width, height }, viewport), height };
}

function clearTrafficLights(placement: SideThreadPlacement, contentHeight: number, viewport: SideThreadViewport): SideThreadPlacement {
	if (!viewport.trafficLights) return placement;
	const { style } = placement;
	const maxHeight = fitHeight(placement.maxHeight, style.width, viewport);
	const height = Math.min(Math.max(0, contentHeight), maxHeight);
	const top = style.top ?? viewport.height - (style.bottom ?? 0) - height;
	const at = clampDragged({ x: style.left, y: top }, { width: style.width, height }, viewport);
	if (at.x === style.left && at.y === top) return { style, maxHeight };
	return { style: { left: at.x, top: at.y, width: style.width }, maxHeight: Math.min(maxHeight, viewport.height - at.y - EDGE) };
}

export function placeSideThread({ kind, rect, viewport, contentHeight }: {
	kind: "composer" | "rect";
	rect: Rect;
	viewport: SideThreadViewport;
	contentHeight: number;
}): SideThreadPlacement {
	if (kind === "composer") {
		return clearTrafficLights({
			style: { left: rect.left, width: rect.right - rect.left, bottom: viewport.height - rect.top + GAP },
			maxHeight: Math.min(CAP_VH * viewport.height, rect.top - GAP - EDGE),
		}, contentHeight, viewport);
	}
	const width = Math.min(SIDE_THREAD_WIDTH, viewport.width - 2 * EDGE);
	const placed = computeMenuPlacement(rect, viewport, contentHeight, "down", "right");
	const right = (placed.style.right as number | undefined) ?? 0;
	const left = Math.max(EDGE, Math.min(viewport.width - right - width, viewport.width - width - EDGE));
	return clearTrafficLights({
		style: {
			left,
			width,
			...(placed.side === "down" ? { top: placed.style.top as number } : { bottom: placed.style.bottom as number }),
		},
		maxHeight: placed.maxHeight,
	}, contentHeight, viewport);
}

/** The smallest height the bottom-edge resize allows when it fits. */
export const SIDE_THREAD_MIN_HEIGHT = 160;

/** Keep the resize handle in view, including windows smaller than the
 * preferred minimum. The caller also applies native-corner clearance. */
export function resizedHeight(startHeight: number, travel: number, top: number, viewportHeight: number): number {
	return Math.min(Math.max(0, viewportHeight - top - EDGE), Math.max(SIDE_THREAD_MIN_HEIGHT, startHeight + travel));
}

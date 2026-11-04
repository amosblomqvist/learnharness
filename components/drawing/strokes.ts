import type { DrawingInk, DrawingPoint, DrawingStroke } from "@/src/core";

/**
 * The drawing pad's stroke model (2026-11-04) — pure geometry, the undo
 * history, and the two renderers (the live dark pad, the exported white
 * page). Strokes live in pad CSS pixels; pressure shapes the width.
 */

/** Ink colors on the exported white page. The colored inks stay as drawn;
 *  the theme ink exports black (always dark ink on white). */
export const EXPORT_INK: Record<DrawingInk, string> = {
	ink: "#000000",
	red: "#ef4444",
	blue: "#3b82f6",
	green: "#22c55e",
};

export const INKS: readonly DrawingInk[] = ["ink", "red", "blue", "green"];

/** The width at mid pressure (a mouse's constant 0.5). */
export const BASE_WIDTH = 2.5;
/** Whole-stroke eraser reach, in pad pixels. */
export const ERASER_RADIUS = 10;
/** Exported margin around the ink, and the longest exported side. */
export const EXPORT_MARGIN = 24;
export const EXPORT_MAX_SIDE = 1600;

/** Pressure → line width: light touches thin out, pressing thickens;
 *  p = 0.5 (the mouse) is exactly BASE_WIDTH. */
export function widthAt(p: number): number {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0.5));
	return BASE_WIDTH * (0.35 + 1.3 * clamped);
}

function distanceToSegment(x: number, y: number, a: DrawingPoint, b: DrawingPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = dx * dx + dy * dy;
	const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len));
	return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** Does an eraser at (x, y) touch this stroke anywhere? */
export function strokeHit(stroke: DrawingStroke, x: number, y: number, radius = ERASER_RADIUS): boolean {
	const pts = stroke.points;
	if (pts.length === 0) return false;
	if (pts.length === 1) return Math.hypot(x - pts[0]!.x, y - pts[0]!.y) <= radius + widthAt(pts[0]!.p) / 2;
	for (let i = 1; i < pts.length; i++) {
		const reach = radius + Math.max(widthAt(pts[i - 1]!.p), widthAt(pts[i]!.p)) / 2;
		if (distanceToSegment(x, y, pts[i - 1]!, pts[i]!) <= reach) return true;
	}
	return false;
}

export interface InkBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** The ink's bounding box, line widths included; null for a blank page. */
export function inkBounds(strokes: readonly DrawingStroke[]): InkBounds | null {
	let b: InkBounds | null = null;
	for (const s of strokes) {
		for (const pt of s.points) {
			const r = widthAt(pt.p) / 2;
			if (!b) b = { minX: pt.x - r, minY: pt.y - r, maxX: pt.x + r, maxY: pt.y + r };
			else {
				b.minX = Math.min(b.minX, pt.x - r);
				b.minY = Math.min(b.minY, pt.y - r);
				b.maxX = Math.max(b.maxX, pt.x + r);
				b.maxY = Math.max(b.maxY, pt.y + r);
			}
		}
	}
	return b;
}

/** Where the export page sits: cropped to the ink plus a margin, scaled
 *  up for crisp lines (`scale`, usually the device pixel ratio) but never
 *  past EXPORT_MAX_SIDE on the longest side. */
export function exportGeometry(bounds: InkBounds, scale = 2): { width: number; height: number; scale: number; originX: number; originY: number } {
	const originX = bounds.minX - EXPORT_MARGIN;
	const originY = bounds.minY - EXPORT_MARGIN;
	const w = bounds.maxX - bounds.minX + EXPORT_MARGIN * 2;
	const h = bounds.maxY - bounds.minY + EXPORT_MARGIN * 2;
	const s = Math.min(scale, EXPORT_MAX_SIDE / Math.max(w, h));
	return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scale: s, originX, originY };
}

/** Samples a stroke may wait for its pen's first real pressure before
 *  painting at mid pressure anyway (a pen that never reports any). */
export const PRESSURE_WAIT_SAMPLES = 6;

/** A pen reports pressure 0 at contact and the real value with its first
 *  motion (OpenTabletDriver Artist Mode via XWayland, probed on a Wacom CTL-672,
 *  2026-11-04): give the stroke's opening points that first real value so
 *  a light stroke never starts with a mid-pressure blob. */
export function backfillStartPressure(points: DrawingPoint[], p: number): void {
	for (const pt of points) pt.p = p;
}

// ─── gesture pointer matching ──────────────────────────────────────────────

/** Primary contact (tip or left button) or a pen's eraser end. */
const CONTACT_BUTTONS = 1 | 32;

/**
 * Does this pointer event belong to the live gesture? Its own pointer
 * always does. So does any other non-touch pointer still in contact:
 * under XWayland (Electron's --ozone-platform=x11 on a Wayland compositor)
 * a Wacom pen's press and release arrive as MOUSE events while its
 * contact motion arrives as PEN events under another pointerId (probe on
 * a Wacom CTL-672, 2026-11-04) — matching ids alone drew only dots.
 */
export function continuesGesture(gesturePointerId: number, e: { pointerId: number; pointerType: string; buttons: number }): boolean {
	if (e.pointerId === gesturePointerId) return true;
	return e.pointerType !== "touch" && (e.buttons & CONTACT_BUTTONS) !== 0;
}

/** Does this release end the live gesture? Its own pointer's does; so does
 *  any other non-touch pointer's (the split pen above may release under
 *  either id — a gesture must never outlive the contact). */
export function endsGesture(gesturePointerId: number, e: { pointerId: number; pointerType: string }): boolean {
	return e.pointerId === gesturePointerId || e.pointerType !== "touch";
}

// ─── pen side buttons (2026-11-04) ─────────────────────────────────────────

export type PadTool = "pen" | "eraser" | "select";
export type ContactMode = "draw" | "erase" | "select";

/** Pointer Events button bits as a Wacom CTL-672 reports them
 *  (OpenTabletDriver Artist Mode via XWayland, probe 2026-11-04): the
 *  LOWER side button arrives as the middle button, the UPPER as the right
 *  (barrel) button, the eraser end as bit 32. */
export const LOWER_BUTTON = 4;
export const UPPER_BUTTON = 2;
const ERASER_END = 32;

/** What a new tip contact does. Only a PEN's held side buttons override
 *  the toolbar: lower → erase, upper → lasso select (a mouse's middle and
 *  right buttons never draw). */
export function contactMode(e: { buttons: number; pointerType: string }, tool: PadTool): ContactMode {
	if (e.pointerType === "pen") {
		if (e.buttons & ERASER_END) return "erase";
		if (e.buttons & LOWER_BUTTON) return "erase";
		if (e.buttons & UPPER_BUTTON) return "select";
	}
	return tool === "pen" ? "draw" : tool === "eraser" ? "erase" : "select";
}

/** Did the tip (or eraser end) just touch? A pen holding a side button
 *  first reports its contact as a MOVE adding bit 1 (4 → 5), not a down. */
export function contactStarts(prevButtons: number, buttons: number): boolean {
	return (buttons & CONTACT_BUTTONS) !== 0 && (prevButtons & CONTACT_BUTTONS) === 0;
}

/** Did the tip just lift while a side button stays held (5 → 4)? */
export function contactEnds(prevButtons: number, buttons: number): boolean {
	return (prevButtons & CONTACT_BUTTONS) !== 0 && (buttons & CONTACT_BUTTONS) === 0;
}

// ─── lasso selection ───────────────────────────────────────────────────────

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}
export type Corner = "nw" | "ne" | "sw" | "se";

/** Air around the ink inside the selection box, the corner handles' reach,
 *  and the smallest a resize may shrink a selection to. */
export const SELECTION_PAD = 6;
export const HANDLE_REACH = 12;
export const MIN_SELECTION_SIDE = 12;

/** Ray casting; points on the boundary count either way. */
export function pointInPolygon(x: number, y: number, poly: readonly { x: number; y: number }[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]!;
		const b = poly[j]!;
		if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}

/** A lasso takes a stroke when at least half its points are inside the loop. */
export function lassoSelects(stroke: DrawingStroke, loop: readonly { x: number; y: number }[]): boolean {
	if (loop.length < 3 || stroke.points.length === 0) return false;
	let inside = 0;
	for (const pt of stroke.points) if (pointInPolygon(pt.x, pt.y, loop)) inside++;
	return inside * 2 >= stroke.points.length;
}

/** The selection box: the ink's bounds plus a little air; null when empty. */
export function selectionBox(strokes: readonly DrawingStroke[]): Box | null {
	const b = inkBounds(strokes);
	if (!b) return null;
	return { x: b.minX - SELECTION_PAD, y: b.minY - SELECTION_PAD, w: b.maxX - b.minX + SELECTION_PAD * 2, h: b.maxY - b.minY + SELECTION_PAD * 2 };
}

export function cornerPoint(box: Box, corner: Corner): { x: number; y: number } {
	return { x: corner.endsWith("w") ? box.x : box.x + box.w, y: corner.startsWith("n") ? box.y : box.y + box.h };
}

export function oppositeCorner(corner: Corner): Corner {
	return ({ nw: "se", ne: "sw", sw: "ne", se: "nw" } as const)[corner];
}

/** Which corner handle (if any) a contact lands on. */
export function handleAt(box: Box, x: number, y: number, reach = HANDLE_REACH): Corner | null {
	for (const c of ["nw", "ne", "sw", "se"] as const) {
		const p = cornerPoint(box, c);
		if (Math.abs(x - p.x) <= reach && Math.abs(y - p.y) <= reach) return c;
	}
	return null;
}

export function insideBox(box: Box, x: number, y: number): boolean {
	return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/** Moved copies — pressure (and so line width) untouched. */
export function translateStrokes(strokes: readonly DrawingStroke[], dx: number, dy: number): DrawingStroke[] {
	return strokes.map((s) => ({ ink: s.ink, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p })) }));
}

/** Scaled copies about an anchor — positions only, so line thickness stays
 *  as drawn (2026-11-04). */
export function scaleStrokes(strokes: readonly DrawingStroke[], anchor: { x: number; y: number }, s: number): DrawingStroke[] {
	return strokes.map((st) => ({
		ink: st.ink,
		points: st.points.map((p) => ({ x: anchor.x + (p.x - anchor.x) * s, y: anchor.y + (p.y - anchor.y) * s, p: p.p })),
	}));
}

/** Where a resize pivots: the far corner of the selected POINTS (widths
 *  excluded) — widths never scale, so the box's far corner stays put. */
export function resizeAnchor(strokes: readonly DrawingStroke[], corner: Corner): { x: number; y: number } {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const st of strokes) {
		for (const p of st.points) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
	}
	const far = oppositeCorner(corner);
	return { x: far.endsWith("w") ? minX : maxX, y: far.startsWith("n") ? minY : maxY };
}

/** The proportional scale for dragging `corner` of `box` to (x, y),
 *  anchored at the opposite corner; never below the minimum side. */
export function resizeFactor(box: Box, corner: Corner, x: number, y: number): number {
	const a = cornerPoint(box, oppositeCorner(corner));
	const c = cornerPoint(box, corner);
	const rx = (x - a.x) / (c.x - a.x || 1);
	const ry = (y - a.y) / (c.y - a.y || 1);
	const min = MIN_SELECTION_SIDE / Math.max(1, Math.min(box.w, box.h));
	return Math.max(min, Math.max(rx, ry));
}

// ─── undo history ──────────────────────────────────────────────────────────

/** Snapshot history: strokes are immutable, so a step is just an array. */
export interface StrokeHistory {
	past: DrawingStroke[][];
	present: DrawingStroke[];
	future: DrawingStroke[][];
}

export const historyOf = (strokes: DrawingStroke[]): StrokeHistory => ({ past: [], present: strokes, future: [] });

/** Commit a new page state as one undo step (clears redo). */
export function commit(h: StrokeHistory, next: DrawingStroke[]): StrokeHistory {
	if (next === h.present) return h;
	return { past: [...h.past, h.present], present: next, future: [] };
}

export function undo(h: StrokeHistory): StrokeHistory {
	if (h.past.length === 0) return h;
	return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] };
}

export function redo(h: StrokeHistory): StrokeHistory {
	if (h.future.length === 0) return h;
	return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) };
}

// ─── rendering (DOM) ───────────────────────────────────────────────────────

/** Paint strokes with round joins, each segment at its own pressure width. */
export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: readonly DrawingStroke[], color: (ink: DrawingInk) => string): void {
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	for (const s of strokes) {
		const pts = s.points;
		if (pts.length === 0) continue;
		ctx.strokeStyle = color(s.ink);
		ctx.fillStyle = color(s.ink);
		if (pts.length === 1) {
			ctx.beginPath();
			ctx.arc(pts[0]!.x, pts[0]!.y, widthAt(pts[0]!.p) / 2, 0, Math.PI * 2);
			ctx.fill();
			continue;
		}
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1]!;
			const b = pts[i]!;
			ctx.lineWidth = (widthAt(a.p) + widthAt(b.p)) / 2;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
	}
}

/** The exported page: white, dark ink, cropped. null for a blank page. */
export function exportDrawingPng(strokes: readonly DrawingStroke[], scale = 2): { png: string; width: number; height: number } | null {
	const bounds = inkBounds(strokes);
	if (!bounds) return null;
	const g = exportGeometry(bounds, scale);
	const canvas = document.createElement("canvas");
	canvas.width = g.width;
	canvas.height = g.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, g.width, g.height);
	ctx.setTransform(g.scale, 0, 0, g.scale, -g.originX * g.scale, -g.originY * g.scale);
	paintStrokes(ctx, strokes, (ink) => EXPORT_INK[ink]);
	const url = canvas.toDataURL("image/png");
	return { png: url.slice(url.indexOf(",") + 1), width: g.width, height: g.height };
}

import type { DrawingInk, DrawingPoint, DrawingStroke } from "@/src/core";

/**
 * The drawing pad's stroke model (2026-11-04) — pure geometry, the undo
 * history, and the two renderers (the live dark pad, the exported white
 * page). Strokes live in pad CSS pixels; pressure shapes the width.
 */

/** Ink colors on the exported white page. The colored inks stay as drawn;
 *  the theme ink exports black (owner: always dark ink on white). */
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
 *  motion (OpenTabletDriver Artist Mode via XWayland, the owner's probe,
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
 * the owner's tablet, 2026-11-04) — matching ids alone drew only dots.
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

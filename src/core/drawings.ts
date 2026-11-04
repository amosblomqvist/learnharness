/**
 * THE LEARNER'S DRAWINGS (2026-11-04): hand-drawn reasoning from the
 * drawing pad, sent beside typed text on a chat message, a practice
 * thinking submission, or a question answer.
 *
 * Two audiences, the show_image/read split:
 *   - the MODEL sees native pi image blocks in the message content, so
 *     every provider path that already carries `read` images carries
 *     these (non-vision models get pi-ai's omitted-image placeholder);
 *   - the UI sees DrawingRefs into the session's imageSnapshots store,
 *     served by /api/chats/[id]/images/[snapshotId] — never base64 in
 *     the projected view.
 */

import type { ImageContent } from "@earendil-works/pi-ai";

/** Drawings per submission (2026-11-04: "several", capped). */
export const MAX_DRAWINGS = 4;

/** Upper bound on one upload's base64 text — a parse-time guard only;
 *  the learner-image pipeline enforces the real pixel/byte bounds. */
export const MAX_DRAWING_BASE64_CHARS = 16 * 1024 * 1024;

/** One drawing as the client uploads it: a base64 PNG export of the pad. */
export interface DrawingUpload {
	data: string;
}

/** One stored drawing, as messages and answers reference it. */
export interface DrawingRef {
	snapshotId: string;
	width: number;
	height: number;
}

/** Server-ingested drawings: refs for the UI, native images for the model
 *  (index-aligned). */
export interface IngestedDrawings {
	refs: DrawingRef[];
	images: ImageContent[];
}

// ─── the pad's editable form (client drafts; never on the wire) ─────────────

/** The pad's inks: the theme ink (light on the dark pad, black on the
 *  exported white page) and three colors that stay as drawn. */
export type DrawingInk = "ink" | "red" | "blue" | "green";

/** One sampled pen point in pad CSS pixels; p = pressure 0–1 (a mouse
 *  reports 0.5 while pressed). */
export interface DrawingPoint {
	x: number;
	y: number;
	p: number;
}

export interface DrawingStroke {
	ink: DrawingInk;
	points: DrawingPoint[];
}

/** One attached drawing: the strokes stay editable (reopening the chip),
 *  the PNG export is what gets sent. */
export interface DrawingAttachment {
	id: string;
	strokes: DrawingStroke[];
	/** base64 PNG (no data: prefix), dark ink on white, cropped to the ink. */
	png: string;
	width: number;
	height: number;
}

/** A drawing-bearing record field, read defensively (records are JSON). */
export function drawingRefsOf(value: unknown): DrawingRef[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(d): d is DrawingRef =>
			typeof d === "object" &&
			d !== null &&
			typeof (d as DrawingRef).snapshotId === "string" &&
			Number.isInteger((d as DrawingRef).width) &&
			Number.isInteger((d as DrawingRef).height),
	);
}

import type { DrawingUpload, IngestedDrawings } from "@/src/core";

/**
 * Process-wide drawing-pad state (2026-11-04), read at EVENT time by the
 * window/document key machines that must go quiet while the pad is up:
 * Enter-submits, the question dock's arrows, and the layered Esc.
 */

let openPads = 0;

/** Is a drawing pad overlay open right now? */
export function isDrawingPadOpen(): boolean {
	return openPads > 0;
}

/** Mark a pad open for its mount; the returned cleanup marks it closed. */
export function markDrawingPadOpen(): () => void {
	openPads++;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		openPads--;
	};
}

/**
 * Optimistic thumbnails: until the server's write-ahead copy (with real
 * snapshot ids) is adopted, an optimistic message's drawings point at
 * LOCAL keys that resolve here. Keyed by the upload's base64, which is
 * all the optimistic send path sees.
 */
export const LOCAL_DRAWING_PREFIX = "local-";

interface LocalDrawing {
	key: string;
	png: string;
	width: number;
	height: number;
}

const byPng = new Map<string, LocalDrawing>();
const byKey = new Map<string, LocalDrawing>();
let seq = 0;

/** Remember an exported drawing so its optimistic thumbnail can render. */
export function rememberLocalDrawing(d: { png: string; width: number; height: number }): void {
	if (byPng.has(d.png)) return;
	const entry = { key: `${LOCAL_DRAWING_PREFIX}${++seq}`, png: d.png, width: d.width, height: d.height };
	byPng.set(d.png, entry);
	byKey.set(entry.key, entry);
}

/** The optimistic stand-in for server ingestion: local refs, no model
 *  images (the optimistic copy never reaches a model). */
export function localIngest(uploads: readonly DrawingUpload[] | undefined): IngestedDrawings | undefined {
	if (!uploads || uploads.length === 0) return undefined;
	const refs = uploads.map((u) => {
		const known = byPng.get(u.data);
		return known
			? { snapshotId: known.key, width: known.width, height: known.height }
			: { snapshotId: `${LOCAL_DRAWING_PREFIX}unknown`, width: 1, height: 1 };
	});
	return { refs, images: [] };
}

/** A local key's image, for optimistic thumbnails. */
export function localDrawingImage(snapshotId: string): LocalDrawing | undefined {
	return byKey.get(snapshotId);
}

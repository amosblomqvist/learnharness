/**
 * Drawing ingestion (2026-11-04): the learner's pad exports arrive as
 * base64 PNGs on an input event. Each one runs the shared learner-image
 * pipeline (bounds, storage form, SHA-256 identity) — the same bytes path
 * show_image and visual use — and comes back as a UI ref, a native image
 * block for the model, and the snapshot to store.
 *
 * Storing is the caller's step, taken only once the input's appends are
 * accepted: a refused answer leaves nothing behind.
 */

import { ChatInputError } from "../core/input-events.ts";
import type { DrawingUpload, IngestedDrawings } from "../core/drawings.ts";
import type { ImageSnapshot } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/index.ts";
import { normalizeLearnerImageBytes } from "../agent/tools/learner-image.ts";

export interface DrawingIngest extends IngestedDrawings {
	snapshots: { snapshotId: string; image: ImageSnapshot }[];
}

/** Decode, validate, and normalize uploads. Throws ChatInputError (an
 *  honest 400) for anything that is not a usable PNG. */
export async function ingestDrawings(uploads: readonly DrawingUpload[], signal?: AbortSignal): Promise<DrawingIngest> {
	const out: DrawingIngest = { refs: [], images: [], snapshots: [] };
	for (const upload of uploads) {
		const bytes = Buffer.from(upload.data, "base64");
		if (detectSupportedImageMimeType(bytes) !== "image/png") throw new ChatInputError("each drawing must be a PNG image");
		let stored: Awaited<ReturnType<typeof normalizeLearnerImageBytes>>;
		try {
			stored = await normalizeLearnerImageBytes(bytes, signal);
		} catch (err) {
			throw new ChatInputError(`drawing could not be read: ${err instanceof Error ? err.message : String(err)}`);
		}
		const { snapshotId, ...image } = stored;
		out.refs.push({ snapshotId, width: image.width, height: image.height });
		out.images.push({ type: "image", data: image.data, mimeType: image.mimeType });
		out.snapshots.push({ snapshotId, image });
	}
	return out;
}

/** Store ingested drawings in the session's snapshot map (deduplicated by
 *  identity) — the transcript thumbnails read them back by ref. */
export function saveDrawingSnapshots(chatStore: Pick<ChatStore, "saveImageSnapshot">, chatId: string, ingest: DrawingIngest | undefined): void {
	for (const { snapshotId, image } of ingest?.snapshots ?? []) chatStore.saveImageSnapshot(chatId, snapshotId, image);
}

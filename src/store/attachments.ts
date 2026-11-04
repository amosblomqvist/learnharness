/**
 * Attachment blobs — the fs adapter for session context attachments
 * (2026-10-29). Content-addressed: the bytes live once, flat under
 * data/attachments/ as `<sha256><ext>`, however many sessions attach the
 * same file; each chat's records (chatStore.addAttachments) point at a
 * blob by name. The learner's original name rides the record only, so no
 * learner-chosen string ever becomes a path.
 *
 * No refcount ledger: a blob is live while any chat record names it.
 * Session deletion sweeps the deleted chat's blobs against the surviving
 * chats (removeBlobsUnreferenced). Pins cover the in-process window
 * between writing a blob and its record landing on the chat — one server
 * process per data dir is the app's standing assumption.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";

const BLOB_PATTERN = /^[0-9a-f]{64}\.[a-z0-9]+$/;

// Module-global on globalThis (compaction.ts's pattern): Next.js may load
// this module more than once per process; the pins must be one set.
const g = globalThis as typeof globalThis & { __lhAttachmentPins?: Map<string, number> };
const pins = (g.__lhAttachmentPins ??= new Map());

/** The blob root (absolute; may not exist yet). */
export function attachmentsRoot(): string {
	return PATHS.attachments;
}

/** Absolute path of one blob, by its stored name. */
export function blobPath(file: string): string {
	if (!BLOB_PATTERN.test(file)) throw new Error(`Invalid attachment blob: ${file}`);
	return path.join(PATHS.attachments, file);
}

/** Store the bytes under their content hash; returns the blob name. An
 *  existing blob is reused as-is; a new one is written to a temp name and
 *  renamed in, so a concurrent identical upload never sees a partial file. */
export function writeBlob(bytes: Uint8Array, ext: string): string {
	if (!/^\.[a-z0-9]+$/.test(ext)) throw new Error(`Invalid attachment extension: ${ext}`);
	const file = `${crypto.createHash("sha256").update(bytes).digest("hex")}${ext}`;
	const target = blobPath(file);
	if (fs.existsSync(target)) return file;
	fs.mkdirSync(PATHS.attachments, { recursive: true });
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;
	fs.writeFileSync(tmp, bytes);
	fs.renameSync(tmp, target);
	return file;
}

/** Hold a blob against sweeps while its record is not yet on a chat. */
export function pinBlob(file: string): void {
	pins.set(file, (pins.get(file) ?? 0) + 1);
}

export function unpinBlob(file: string): void {
	const n = (pins.get(file) ?? 0) - 1;
	if (n > 0) pins.set(file, n);
	else pins.delete(file);
}

/** Delete each candidate blob that no chat references and no upload holds. */
export function removeBlobsUnreferenced(candidates: Iterable<string>, referenced: ReadonlySet<string>): void {
	for (const file of candidates) {
		if (referenced.has(file) || pins.has(file) || !BLOB_PATTERN.test(file)) continue;
		fs.rmSync(blobPath(file), { force: true });
	}
}

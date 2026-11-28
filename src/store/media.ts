/**
 * MediaStore — content-addressed binary media adapter (data/media/<chatId>/).
 *
 * Each asset is written once under `<chatId>/<sha256>.<ext>` with a sibling
 * `<chatId>/<sha256>.json` metadata sidecar. Both chatId and mediaId are
 * strictly regex-checked before constructing paths so traversal is impossible.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { MediaStore } from "../core/ports.ts";
import {
	MAX_MEDIA_TRANSCRIPT_CHARS,
	MEDIA_ID_RE,
	mediaExtensionForMime,
	mediaKindFromMime,
	normalizeMediaMimeType,
	type MediaKind,
	type StoredMediaEntry,
} from "../core/contracts.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const CHAT_ID_RE = /^[A-Za-z0-9_-]+$/;

function chatMediaDir(chatId: string): string {
	if (!CHAT_ID_RE.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(/* turbopackIgnore: true */ PATHS.media, chatId);
}

function metaFilePath(chatId: string, mediaId: string): string {
	if (!MEDIA_ID_RE.test(mediaId)) throw new Error(`Invalid media id: ${mediaId}`);
	return path.join(/* turbopackIgnore: true */ chatMediaDir(chatId), `${mediaId}.json`);
}

function binaryFilePath(chatId: string, mediaId: string, ext: string): string {
	if (!MEDIA_ID_RE.test(mediaId)) throw new Error(`Invalid media id: ${mediaId}`);
	if (!/^[a-z0-9]+$/.test(ext)) throw new Error(`Invalid media extension: ${ext}`);
	return path.join(/* turbopackIgnore: true */ chatMediaDir(chatId), `${mediaId}.${ext}`);
}

function sanitizeFilename(raw: string): string {
	const base = raw.split(/[\\/]/).pop()?.trim() ?? "";
	const clean = base.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
	return clean || "media";
}

function saveMedia(
	chatId: string,
	bytes: Uint8Array,
	meta: { kind: MediaKind; mimeType: string; filename: string },
): StoredMediaEntry {
	const mimeType = normalizeMediaMimeType(meta.mimeType);
	if (!mimeType) throw new Error(`Unsupported media MIME type: ${meta.mimeType}`);
	const kind = mediaKindFromMime(mimeType);
	if (!kind || kind !== meta.kind) throw new Error(`Media kind "${meta.kind}" does not match MIME "${mimeType}"`);
	if (bytes.byteLength === 0) throw new Error("Media file is empty");

	const id = createHash("sha256").update(bytes).digest("hex");
	const ext = mediaExtensionForMime(mimeType);
	const dir = chatMediaDir(chatId);
	fs.mkdirSync(dir, { recursive: true });

	const existing = getMediaMeta(chatId, id);
	const dataPath = binaryFilePath(chatId, id, existing?.ext ?? ext);
	if (existing && fs.existsSync(dataPath)) {
		return existing;
	}

	const entry: StoredMediaEntry = {
		id,
		kind,
		mimeType,
		filename: sanitizeFilename(meta.filename),
		sizeBytes: bytes.byteLength,
		ext,
		createdAt: new Date().toISOString(),
	};

	const targetDataPath = binaryFilePath(chatId, id, ext);
	const tmpDataPath = `${targetDataPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(/* turbopackIgnore: true */ tmpDataPath, bytes);
		fs.renameSync(/* turbopackIgnore: true */ tmpDataPath, /* turbopackIgnore: true */ targetDataPath);
	} catch (error) {
		try { fs.rmSync(/* turbopackIgnore: true */ tmpDataPath, { force: true }); } catch { /* ignore cleanup error */ }
		throw error;
	}
	writeFileAtomicSync(metaFilePath(chatId, id), JSON.stringify(entry, null, "\t"), { allowInPlaceFallback: true });
	return entry;
}

function getMediaMeta(chatId: string, mediaId: string): StoredMediaEntry | null {
	if (!CHAT_ID_RE.test(chatId) || !MEDIA_ID_RE.test(mediaId)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ metaFilePath(chatId, mediaId), "utf-8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const v = parsed as Partial<StoredMediaEntry>;
	if (
		v.id !== mediaId ||
		(v.kind !== "image" && v.kind !== "audio" && v.kind !== "video") ||
		typeof v.mimeType !== "string" ||
		typeof v.filename !== "string" ||
		typeof v.sizeBytes !== "number" ||
		typeof v.ext !== "string" ||
		!/^[a-z0-9]+$/.test(v.ext) ||
		typeof v.createdAt !== "string"
	) {
		return null;
	}
	return v as StoredMediaEntry;
}

function updateMediaTranscript(chatId: string, mediaId: string, transcript: string): StoredMediaEntry | null {
	const existing = getMediaMeta(chatId, mediaId);
	if (!existing) return null;
	const trimmed = transcript.trim().slice(0, MAX_MEDIA_TRANSCRIPT_CHARS);
	if (!trimmed) return existing;
	const updated: StoredMediaEntry = { ...existing, transcript: trimmed };
	writeFileAtomicSync(metaFilePath(chatId, mediaId), JSON.stringify(updated, null, "\t"), { allowInPlaceFallback: true });
	return updated;
}

function getMediaFilePath(chatId: string, mediaId: string): string | null {
	const meta = getMediaMeta(chatId, mediaId);
	if (!meta) return null;
	const filePath = binaryFilePath(chatId, mediaId, meta.ext);
	try {
		const stat = fs.statSync(/* turbopackIgnore: true */ filePath);
		return stat.isFile() ? filePath : null;
	} catch {
		return null;
	}
}

function deleteMediaForChat(chatId: string): number {
	if (!CHAT_ID_RE.test(chatId)) return 0;
	const dir = chatMediaDir(chatId);
	let removed = 0;
	try {
		const entries = fs.readdirSync(/* turbopackIgnore: true */ dir);
		removed = entries.filter((name) => name.endsWith(".json")).length;
		fs.rmSync(/* turbopackIgnore: true */ dir, { recursive: true, force: true });
	} catch {
		return 0;
	}
	return removed;
}

export const mediaStore: MediaStore = {
	saveMedia,
	getMediaMeta,
	updateMediaTranscript,
	getMediaFilePath,
	deleteMediaForChat,
};

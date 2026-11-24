/**
 * Server-side media service — upload validation, HTTP Range streaming,
 * session-attachment verification, and optional BYOK batch STT transcription.
 */

import * as fs from "node:fs";
import { Readable } from "node:stream";
import {
	MAX_MEDIA_TRANSCRIPT_CHARS,
	maxBytesForMediaKind,
	mediaKindFromMime,
	mediaMimeFromFilename,
	normalizeMediaMimeType,
	type MediaAttachment,
	type MediaKind,
} from "../core/contracts.ts";
import { stores } from "./stores.ts";
import { keyValue } from "./keys.ts";

/** Sniff magic bytes for common image/audio/video containers to back up MIME checks. */
export function sniffMediaMime(bytes: Uint8Array): string | null {
	if (bytes.length < 4) return null;
	// PNG
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
	// JPEG
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	// GIF
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
	// BMP
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
	// RIFF (WEBP or WAV)
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		const tag = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
		if (tag === "WEBP") return "image/webp";
		if (tag === "WAVE") return "audio/wav";
	}
	// FLAC
	if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";
	// Ogg (audio/ogg or video/ogg)
	if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
	// MP3 (ID3 tag or frame sync)
	if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
	// EBML / WebM
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
	// ISO BMFF (MP4 / M4A / MOV): ....ftyp
	if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
		const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
		if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
		if (brand === "qt  ") return "video/quicktime";
		return "video/mp4";
	}
	return null;
}

export class MediaUploadError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Resolve and validate MIME + kind for an uploaded media buffer. */
export function resolveUploadedMediaType(
	bytes: Uint8Array,
	declaredMime: string | undefined,
	filename: string,
): { kind: MediaKind; mimeType: string } {
	const sniffed = sniffMediaMime(bytes);
	const declared = normalizeMediaMimeType(declaredMime);
	const fromExt = mediaMimeFromFilename(filename);

	// Prefer declared/extension MIME when container is shared (e.g. webm/ogg/mp4 can be audio or video).
	let mimeType: string | null = null;
	if (sniffed && (sniffed === "video/webm" || sniffed === "audio/ogg" || sniffed === "video/mp4")) {
		const candidate = declared ?? fromExt;
		if (candidate && (
			(sniffed === "video/webm" && (candidate === "audio/webm" || candidate === "video/webm")) ||
			(sniffed === "audio/ogg" && (candidate === "audio/ogg" || candidate === "video/ogg")) ||
			(sniffed === "video/mp4" && (candidate === "audio/mp4" || candidate === "video/mp4" || candidate === "video/quicktime"))
		)) {
			mimeType = candidate;
		} else {
			mimeType = sniffed;
		}
	} else {
		mimeType = sniffed ?? declared ?? fromExt;
	}

	if (!mimeType) {
		throw new MediaUploadError("Unsupported media file type. Supported formats: images, MP3/WAV/M4A/OGG/FLAC/WebM audio, and MP4/WebM/MOV video.");
	}
	const kind = mediaKindFromMime(mimeType);
	if (!kind) {
		throw new MediaUploadError(`Unsupported media MIME type: ${mimeType}`);
	}
	const limit = maxBytesForMediaKind(kind);
	if (bytes.byteLength === 0) throw new MediaUploadError("Uploaded file is empty.");
	if (bytes.byteLength > limit) {
		throw new MediaUploadError(`File exceeds the ${Math.round(limit / (1024 * 1024))} MiB limit.`, 413);
	}
	return { kind, mimeType };
}

/** Save uploaded bytes into a chat's MediaStore and return the lightweight attachment metadata. */
export function saveUploadedMedia(
	chatId: string,
	bytes: Uint8Array,
	opts: { mimeType?: string; filename: string },
): MediaAttachment {
	if (!stores.chatStore.getChat(chatId)) {
		throw new MediaUploadError("Session not found", 404);
	}
	const { kind, mimeType } = resolveUploadedMediaType(bytes, opts.mimeType, opts.filename);
	const entry = stores.mediaStore.saveMedia(chatId, bytes, { kind, mimeType, filename: opts.filename });
	return {
		id: entry.id,
		kind: entry.kind,
		mimeType: entry.mimeType,
		filename: entry.filename,
		sizeBytes: entry.sizeBytes,
	};
}

/** Verify every referenced media attachment exists in the chat's MediaStore. */
export function verifyChatMediaAttachments(chatId: string, attachments: readonly MediaAttachment[] | undefined): MediaAttachment[] | undefined {
	if (!attachments?.length) return undefined;
	return attachments.map((item) => {
		const meta = stores.mediaStore.getMediaMeta(chatId, item.id);
		if (!meta) {
			throw new MediaUploadError(`Media attachment ${item.id.slice(0, 12)} was not found in this session.`);
		}
		if (item.transcript && !meta.transcript) {
			stores.mediaStore.updateMediaTranscript(chatId, item.id, item.transcript);
		}
		const transcript = item.transcript ?? meta.transcript;
		return {
			...item,
			kind: meta.kind,
			mimeType: meta.mimeType,
			sizeBytes: meta.sizeBytes,
			...(transcript ? { transcript } : {}),
		};
	});
}

/** Parse a single HTTP byte Range header ("bytes=start-end"). Returns null if malformed. */
export function parseByteRange(header: string, totalBytes: number): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match) return null;
	const [, startRaw, endRaw] = match;
	if (!startRaw && !endRaw) return null;
	let start: number;
	let end: number;
	if (!startRaw) {
		const suffix = Number.parseInt(endRaw!, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		start = Math.max(0, totalBytes - suffix);
		end = totalBytes - 1;
	} else {
		start = Number.parseInt(startRaw, 10);
		end = endRaw ? Math.min(Number.parseInt(endRaw, 10), totalBytes - 1) : totalBytes - 1;
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= totalBytes) {
		return null;
	}
	return { start, end };
}

/** Stream a stored media asset with full HTTP Range (206 Partial Content) support. */
export function buildMediaFileResponse(request: Request, chatId: string, mediaId: string): Response {
	const meta = stores.mediaStore.getMediaMeta(chatId, mediaId);
	const filePath = meta ? stores.mediaStore.getMediaFilePath(chatId, mediaId) : null;
	if (!meta || !filePath) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	let totalBytes: number;
	try {
		totalBytes = fs.statSync(filePath).size;
	} catch {
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	const baseHeaders: Record<string, string> = {
		"Content-Type": meta.mimeType,
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
	};

	const rangeHeader = request.headers.get("range");
	if (rangeHeader) {
		const range = parseByteRange(rangeHeader, totalBytes);
		if (!range) {
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${totalBytes}` },
			});
		}
		const chunkSize = range.end - range.start + 1;
		const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
		return new Response(Readable.toWeb(stream) as ReadableStream, {
			status: 206,
			headers: {
				...baseHeaders,
				"Content-Range": `bytes ${range.start}-${range.end}/${totalBytes}`,
				"Content-Length": String(chunkSize),
			},
		});
	}

	const stream = fs.createReadStream(filePath);
	return new Response(Readable.toWeb(stream) as ReadableStream, {
		status: 200,
		headers: {
			...baseHeaders,
			"Content-Length": String(totalBytes),
		},
	});
}

export interface TranscribeOutcome {
	available: boolean;
	provider?: "deepgram" | "openai";
	transcript: string | null;
	error?: string;
}

/**
 * Best-effort batch STT transcription for an audio/video buffer using configured
 * BYOK keys (Deepgram first, then OpenAI Whisper). Returns `{ available: false, transcript: null }`
 * when no STT key is configured so uploads never fail solely due to missing STT.
 */
export async function transcribeMediaBytes(
	bytes: Uint8Array,
	mimeType: string,
	filename: string,
	signal?: AbortSignal,
): Promise<TranscribeOutcome> {
	const deepgramKey = keyValue("DEEPGRAM_API_KEY");
	if (deepgramKey) {
		try {
			const res = await fetch("https://api.deepgram.com/v1/listen?smart_format=true&model=nova-3", {
				method: "POST",
				headers: {
					Authorization: `Token ${deepgramKey}`,
					"Content-Type": mimeType,
				},
				body: Buffer.from(bytes),
				signal,
			});
			if (!res.ok) {
				return { available: true, provider: "deepgram", transcript: null, error: `Deepgram transcription failed (${res.status})` };
			}
			const data = (await res.json()) as {
				results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
			};
			const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
			return {
				available: true,
				provider: "deepgram",
				transcript: text ? text.slice(0, MAX_MEDIA_TRANSCRIPT_CHARS) : null,
			};
		} catch (error) {
			return { available: true, provider: "deepgram", transcript: null, error: error instanceof Error ? error.message : "Transcription failed" };
		}
	}

	const openAiKey = keyValue("OPENAI_API_KEY");
	if (openAiKey) {
		try {
			const form = new FormData();
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			form.append("file", new Blob([copy], { type: mimeType }), filename || "audio.mp3");
			form.append("model", "whisper-1");
			const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
				method: "POST",
				headers: { Authorization: `Bearer ${openAiKey}` },
				body: form,
				signal,
			});
			if (!res.ok) {
				return { available: true, provider: "openai", transcript: null, error: `OpenAI transcription failed (${res.status})` };
			}
			const data = (await res.json()) as { text?: string };
			const text = data.text?.trim() ?? "";
			return {
				available: true,
				provider: "openai",
				transcript: text ? text.slice(0, MAX_MEDIA_TRANSCRIPT_CHARS) : null,
			};
		} catch (error) {
			return { available: true, provider: "openai", transcript: null, error: error instanceof Error ? error.message : "Transcription failed" };
		}
	}

	return { available: false, transcript: null };
}

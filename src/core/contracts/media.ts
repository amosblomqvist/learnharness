/**
 * Multi-media contracts — pure, browser-safe types, MIME allowlists,
 * validation, YouTube URL parsing, and model-facing formatting.
 *
 * Binary bytes live in MediaStore (data/media/<chatId>/<sha256>.<ext>), never
 * embedded as base64 inside chats/*.json. Chat messages and show_media tool
 * results carry lightweight metadata references only.
 */

export type MediaKind = "image" | "audio" | "video";

export const MAX_MEDIA_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_MEDIA_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB (matches Next proxy 26 MiB headroom)
export const MAX_MEDIA_FORM_BODY_BYTES = 26 * 1024 * 1024; // 26 MiB multipart wrapper headroom
export const MAX_MEDIA_ATTACHMENTS_PER_MESSAGE = 6;
export const MAX_VIDEO_KEYFRAMES = 4;
export const MAX_MEDIA_TRANSCRIPT_CHARS = 24_000;

export const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
});

export const AUDIO_MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/wave": "wav",
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
	"audio/aac": "aac",
});

export const VIDEO_MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"video/ogg": "ogv",
});

const EXT_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	flac: "audio/flac",
	aac: "audio/aac",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	ogv: "video/ogg",
});

export const ACCEPT_MEDIA_EXTENSIONS =
	"image/jpeg,image/png,image/gif,image/webp,image/bmp,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg,audio/flac,audio/aac,video/mp4,video/webm,video/quicktime,video/ogg,.jpg,.jpeg,.png,.gif,.webp,.bmp,.mp3,.m4a,.wav,.ogg,.flac,.aac,.mp4,.webm,.mov";

export const MEDIA_ID_RE = /^[a-f0-9]{64}$/;

/** Normalize a raw Content-Type / MIME string (strips parameters, canonicalizes aliases). */
export function normalizeMediaMimeType(raw: string | undefined | null): string | null {
	if (typeof raw !== "string") return null;
	const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!base) return null;
	if (base === "audio/mp3") return "audio/mpeg";
	if (base === "audio/x-m4a") return "audio/mp4";
	if (base === "audio/x-wav" || base === "audio/wave") return "audio/wav";
	if (base in IMAGE_MIME_EXTENSIONS || base in AUDIO_MIME_EXTENSIONS || base in VIDEO_MIME_EXTENSIONS) {
		return base;
	}
	return null;
}

/** Infer a supported MIME type from a filename extension when the browser/OS omits one. */
export function mediaMimeFromFilename(filename: string): string | null {
	const dot = filename.lastIndexOf(".");
	if (dot < 0 || dot === filename.length - 1) return null;
	const ext = filename.slice(dot + 1).toLowerCase();
	return EXT_TO_MIME[ext] ?? null;
}

export function mediaKindFromMime(mimeType: string): MediaKind | null {
	const norm = normalizeMediaMimeType(mimeType);
	if (!norm) return null;
	if (norm in IMAGE_MIME_EXTENSIONS) return "image";
	if (norm in AUDIO_MIME_EXTENSIONS) return "audio";
	if (norm in VIDEO_MIME_EXTENSIONS) return "video";
	return null;
}

export function mediaExtensionForMime(mimeType: string): string {
	const norm = normalizeMediaMimeType(mimeType);
	if (!norm) return "bin";
	return IMAGE_MIME_EXTENSIONS[norm] ?? AUDIO_MIME_EXTENSIONS[norm] ?? VIDEO_MIME_EXTENSIONS[norm] ?? "bin";
}

export function maxBytesForMediaKind(kind: MediaKind): number {
	return kind === "image" ? MAX_MEDIA_IMAGE_BYTES : MAX_MEDIA_UPLOAD_BYTES;
}

/** Lightweight metadata stored on user messages (binary bytes live in MediaStore). */
export interface MediaAttachment {
	id: string;
	kind: MediaKind;
	mimeType: string;
	filename: string;
	sizeBytes: number;
	durationSec?: number;
	width?: number;
	height?: number;
	/** Optional speech-to-text transcript extracted for audio/video uploads. */
	transcript?: string;
	/** Number of video keyframes appended to the message's native images array. */
	keyframeCount?: number;
}

/** Stored metadata sidecar written beside <sha256>.<ext> in MediaStore. */
export interface StoredMediaEntry {
	id: string;
	kind: MediaKind;
	mimeType: string;
	filename: string;
	sizeBytes: number;
	ext: string;
	createdAt: string;
	/** Optional cached subtitle/STT transcript for audio or video assets. */
	transcript?: string;
}

/** Payload persisted in ToolResultMessage.details for the `show_media` tool. */
export type ShowMediaDetails =
	| {
			source: "local";
			mediaId: string;
			kind: "audio" | "video";
			mimeType: string;
			filename: string;
			path?: string;
			caption?: string;
			startSec?: number;
			endSec?: number;
			transcript?: string;
	  }
	| {
			source: "youtube";
			videoId: string;
			url: string;
			caption?: string;
			startSec?: number;
			endSec?: number;
			transcript?: string;
			subtitleLanguage?: string;
	  };

function sanitizeFilename(raw: string): string {
	const base = raw.split(/[\\/]/).pop()?.trim() ?? "";
	const clean = base.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
	return clean || "media";
}

/** Validate and normalize one MediaAttachment from untrusted JSON input. */
export function validateMediaAttachment(value: unknown): MediaAttachment {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Media attachment must be an object");
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || !MEDIA_ID_RE.test(v.id)) {
		throw new Error("Media attachment requires a valid SHA-256 id");
	}
	const mimeType = normalizeMediaMimeType(typeof v.mimeType === "string" ? v.mimeType : "");
	if (!mimeType) {
		throw new Error(`Unsupported media MIME type: ${String(v.mimeType)}`);
	}
	const kind = mediaKindFromMime(mimeType);
	if (!kind || (v.kind !== undefined && v.kind !== kind)) {
		throw new Error("Media attachment kind does not match its MIME type");
	}
	if (typeof v.filename !== "string" || !v.filename.trim()) {
		throw new Error("Media attachment requires a filename");
	}
	if (typeof v.sizeBytes !== "number" || !Number.isFinite(v.sizeBytes) || v.sizeBytes <= 0 || v.sizeBytes > maxBytesForMediaKind(kind)) {
		throw new Error("Media attachment size is out of bounds");
	}
	const out: MediaAttachment = {
		id: v.id,
		kind,
		mimeType,
		filename: sanitizeFilename(v.filename),
		sizeBytes: Math.round(v.sizeBytes),
	};
	if (v.durationSec !== undefined) {
		if (typeof v.durationSec !== "number" || !Number.isFinite(v.durationSec) || v.durationSec < 0 || v.durationSec > 86_400) {
			throw new Error("Invalid media duration");
		}
		out.durationSec = Math.round(v.durationSec * 100) / 100;
	}
	if (v.width !== undefined) {
		if (typeof v.width !== "number" || !Number.isFinite(v.width) || v.width <= 0 || v.width > 16_384) {
			throw new Error("Invalid media width");
		}
		out.width = Math.round(v.width);
	}
	if (v.height !== undefined) {
		if (typeof v.height !== "number" || !Number.isFinite(v.height) || v.height <= 0 || v.height > 16_384) {
			throw new Error("Invalid media height");
		}
		out.height = Math.round(v.height);
	}
	if (v.transcript !== undefined) {
		if (typeof v.transcript !== "string") throw new Error("Media transcript must be a string");
		const trimmed = v.transcript.trim();
		if (trimmed) out.transcript = trimmed.slice(0, MAX_MEDIA_TRANSCRIPT_CHARS);
	}
	if (v.keyframeCount !== undefined) {
		if (typeof v.keyframeCount !== "number" || !Number.isInteger(v.keyframeCount) || v.keyframeCount < 0 || v.keyframeCount > MAX_VIDEO_KEYFRAMES) {
			throw new Error("Invalid video keyframe count");
		}
		if (v.keyframeCount > 0) out.keyframeCount = v.keyframeCount;
	}
	return out;
}

export function validateMediaAttachmentArray(value: unknown): MediaAttachment[] {
	if (!Array.isArray(value)) throw new Error("Media attachments must be an array");
	if (value.length > MAX_MEDIA_ATTACHMENTS_PER_MESSAGE) {
		throw new Error(`At most ${MAX_MEDIA_ATTACHMENTS_PER_MESSAGE} media attachments per message`);
	}
	return value.map(validateMediaAttachment);
}

/** Format seconds into mm:ss or h:mm:ss for UI labels and model context. */
export function formatMediaTimestamp(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parse a YouTube timestamp param like "90", "90s", "1m30s", "1h2m3s". */
function parseYouTubeTimeParam(raw: string | null): number | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim().toLowerCase();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
	if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
	return (Number(match[1] ?? 0) * 3600) + (Number(match[2] ?? 0) * 60) + Number(match[3] ?? 0);
}

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
	"youtu.be",
]);

/** Parse a YouTube URL (watch, youtu.be, embed, shorts) into canonical videoId + optional startSec. */
export function parseYouTubeVideoId(input: string): { videoId: string; url: string; startSec?: number } | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const host = parsed.hostname.toLowerCase();
	if (!YOUTUBE_HOSTS.has(host)) return null;

	let videoId: string | null = null;
	const segments = parsed.pathname.split("/").filter(Boolean);
	if (host === "youtu.be") {
		videoId = segments[0] ?? null;
	} else if (parsed.pathname === "/watch") {
		videoId = parsed.searchParams.get("v");
	} else if (segments.length >= 2 && (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live" || segments[0] === "v")) {
		videoId = segments[1] ?? null;
	}
	if (!videoId || !YOUTUBE_ID_RE.test(videoId)) return null;

	const startSec =
		parseYouTubeTimeParam(parsed.searchParams.get("t")) ??
		parseYouTubeTimeParam(parsed.searchParams.get("start"));
	return {
		videoId,
		url: `https://www.youtube.com/watch?v=${videoId}`,
		...(startSec !== undefined && startSec > 0 ? { startSec } : {}),
	};
}

/** Build the model-facing context block describing learner-attached audio/video media. */
export function formatMediaForModel(attachments: readonly MediaAttachment[]): string {
	if (!attachments.length) return "";
	const blocks = attachments.map((item) => {
		const meta: string[] = [item.mimeType];
		if (item.durationSec !== undefined) meta.push(formatMediaTimestamp(item.durationSec));
		if (item.width && item.height) meta.push(`${item.width}×${item.height}`);
		if (item.keyframeCount) meta.push(`${item.keyframeCount} sampled keyframes attached as images`);
		const header = `[Attached ${item.kind}: ${item.filename} (${meta.join(", ")}; mediaId: ${item.id})]`;
		if (item.transcript) {
			return `${header}\nTranscript:\n${item.transcript}`;
		}
		return header;
	});
	return blocks.join("\n\n");
}

/** Type guard for ShowMediaDetails stored in ToolResultMessage.details. */
export function isShowMediaDetails(value: unknown): value is ShowMediaDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.source === "youtube") {
		return typeof v.videoId === "string" && YOUTUBE_ID_RE.test(v.videoId) && typeof v.url === "string";
	}
	if (v.source === "local") {
		return (
			typeof v.mediaId === "string" &&
			MEDIA_ID_RE.test(v.mediaId) &&
			(v.kind === "audio" || v.kind === "video") &&
			typeof v.mimeType === "string" &&
			typeof v.filename === "string"
		);
	}
	return false;
}

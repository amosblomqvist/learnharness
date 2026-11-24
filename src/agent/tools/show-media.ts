import * as fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { fetchYouTubeSubtitles, loadLocalSubtitles } from "./media-subtitles.ts";
import {
	formatMediaTimestamp,
	MAX_MEDIA_UPLOAD_BYTES,
	MEDIA_ID_RE,
	mediaKindFromMime,
	mediaMimeFromFilename,
	parseYouTubeVideoId,
	type ShowMediaDetails,
} from "../../core/contracts.ts";
import type { MediaStore } from "../../core/ports.ts";

/**
 * show_media: embed playable audio, video, or a YouTube clip directly in the
 * lesson transcript (the audio/video twin of show_image).
 *
 * SUBTITLES INVARIANT: Any audio or video collected/shown by the agent MUST
 * have readable subtitles or a transcript available. `show_media` verifies and
 * extracts subtitles (YouTube captions, sibling/explicit .vtt/.srt files, or
 * STT transcription), rejects clips without subtitles, and returns the
 * timestamped transcript directly to the agent so it can teach from the clip.
 */

const showMediaInput = Type.Object({
	path: Type.Optional(Type.String({ minLength: 1, description: "Path to a local audio or video file (mp3, wav, m4a, ogg, flac, mp4, webm, mov)." })),
	subtitlePath: Type.Optional(Type.String({ minLength: 1, description: "Optional path to a .vtt or .srt subtitle file for a local audio/video file (sibling .vtt/.srt files are also discovered automatically)." })),
	mediaId: Type.Optional(Type.String({ minLength: 1, description: "SHA-256 mediaId of an audio or video clip already attached in this session." })),
	youtubeUrl: Type.Optional(Type.String({ minLength: 1, description: "YouTube URL (youtube.com/watch?v=..., youtu.be/..., shorts, or embed) with captions enabled." })),
	startSec: Type.Optional(Type.Number({ minimum: 0, description: "Optional start timestamp in seconds." })),
	endSec: Type.Optional(Type.Number({ minimum: 1, description: "Optional end timestamp in seconds (must be greater than startSec)." })),
	caption: Type.Optional(Type.String({ description: "Short caption shown under the player." })),
});

export type MediaTranscriber = (
	bytes: Uint8Array,
	mimeType: string,
	filename: string,
	signal?: AbortSignal,
) => Promise<string | null>;

function sniffAudioVideoMime(bytes: Uint8Array): string | null {
	if (bytes.length < 4) return null;
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		const tag = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
		if (tag === "WAVE") return "audio/wav";
	}
	if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";
	if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
	if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
	if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
		const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
		if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
		if (brand === "qt  ") return "video/quicktime";
		return "video/mp4";
	}
	return null;
}

function formatRangeNote(startSec?: number, endSec?: number): string {
	if (startSec !== undefined && endSec !== undefined) return ` [${formatMediaTimestamp(startSec)}–${formatMediaTimestamp(endSec)}]`;
	if (startSec !== undefined) return ` [from ${formatMediaTimestamp(startSec)}]`;
	if (endSec !== undefined) return ` [until ${formatMediaTimestamp(endSec)}]`;
	return "";
}

async function readBoundedLocalMedia(absolute: string, signal?: AbortSignal): Promise<Uint8Array> {
	const stat = await fs.stat(absolute);
	if (!stat.isFile()) throw new Error("Not a regular file.");
	if (stat.size === 0) throw new Error("Media file is empty.");
	if (stat.size > MAX_MEDIA_UPLOAD_BYTES) {
		throw new Error(`Media file exceeds the ${Math.round(MAX_MEDIA_UPLOAD_BYTES / (1024 * 1024))} MiB limit.`);
	}
	const buffer = await fs.readFile(absolute, { signal });
	if (buffer.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
		throw new Error(`Media file exceeds the ${Math.round(MAX_MEDIA_UPLOAD_BYTES / (1024 * 1024))} MiB limit.`);
	}
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function createShowMediaTool(ctx: {
	chatId: string;
	mediaStore?: Pick<MediaStore, "saveMedia" | "getMediaMeta" | "updateMediaTranscript" | "getMediaFilePath">;
	transcribeMedia?: MediaTranscriber;
}): AgentTool<typeof showMediaInput> {
	return {
		name: "show_media",
		label: "show_media",
		description:
			"Show playable audio, video, or a YouTube video clip inline in the lesson, with an optional caption and start/end timestamps. " +
			"Subtitles or a transcript are REQUIRED for every clip — the tool verifies and returns the timestamped subtitles/transcript so you can teach directly from it, and refuses clips without subtitles. " +
			"Pass exactly ONE of: `youtubeUrl` (must have captions enabled), `mediaId` (an attached session clip with a transcript), " +
			"or `path` (a local audio/video file with a sibling/explicit .vtt/.srt subtitle file or configured STT transcription; follows File access settings).",
		parameters: showMediaInput,
		execute: serverExecute("show_media", showMediaInput, async (input, { signal }) => {
			const sources = [input.path !== undefined, input.mediaId !== undefined, input.youtubeUrl !== undefined].filter(Boolean).length;
			if (sources !== 1) {
				throw new Error("Pass exactly one of `path`, `mediaId`, or `youtubeUrl`.");
			}
			if (input.subtitlePath !== undefined && input.path === undefined) {
				throw new Error("`subtitlePath` can only be used together with `path`.");
			}
			const startSec = input.startSec !== undefined ? Math.floor(input.startSec) : undefined;
			const endSec = input.endSec !== undefined ? Math.floor(input.endSec) : undefined;
			if (startSec !== undefined && endSec !== undefined && endSec <= startSec) {
				throw new Error("`endSec` must be greater than `startSec`.");
			}
			const caption = input.caption?.trim() || undefined;

			if (input.youtubeUrl !== undefined) {
				const parsed = parseYouTubeVideoId(input.youtubeUrl);
				if (!parsed) {
					throw new Error("Invalid YouTube URL. Provide a valid youtube.com or youtu.be link.");
				}
				const effectiveStart = startSec ?? parsed.startSec;
				if (effectiveStart !== undefined && endSec !== undefined && endSec <= effectiveStart) {
					throw new Error("`endSec` must be greater than the start timestamp.");
				}
				// Mandatory subtitle verification & extraction for YouTube videos.
				const subs = await fetchYouTubeSubtitles(parsed.videoId, {
					startSec: effectiveStart,
					endSec,
					signal,
				});
				const details: ShowMediaDetails = {
					source: "youtube",
					videoId: parsed.videoId,
					url: parsed.url,
					...(caption ? { caption } : {}),
					...(effectiveStart !== undefined ? { startSec: effectiveStart } : {}),
					...(endSec !== undefined ? { endSec } : {}),
					transcript: subs.transcript,
					subtitleLanguage: subs.language,
				};
				const langNote = subs.autoGenerated ? `${subs.language}, auto-captions` : subs.language;
				return {
					text: `Shown YouTube video (${parsed.videoId})${formatRangeNote(effectiveStart, endSec)}.\nSubtitles (${langNote}):\n${subs.transcript}`,
					details,
				};
			}

			if (!ctx.mediaStore) {
				throw new Error("Session media storage is unavailable in this runtime.");
			}

			if (input.mediaId !== undefined) {
				if (!MEDIA_ID_RE.test(input.mediaId)) {
					throw new Error("Invalid mediaId format.");
				}
				const meta = ctx.mediaStore.getMediaMeta(ctx.chatId, input.mediaId);
				if (!meta) {
					throw new Error(`No media asset found in this session for mediaId ${input.mediaId.slice(0, 12)}.`);
				}
				if (meta.kind !== "audio" && meta.kind !== "video") {
					throw new Error("`show_media` plays audio or video assets; use `show_image` for images.");
				}
				let transcript = meta.transcript?.trim() || "";
				if (!transcript && ctx.transcribeMedia) {
					const storedPath = ctx.mediaStore.getMediaFilePath(ctx.chatId, meta.id);
					if (storedPath) {
						const raw = await fs.readFile(storedPath, { signal });
						const generated = await ctx.transcribeMedia(
							new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
							meta.mimeType,
							meta.filename,
							signal,
						);
						if (generated?.trim()) {
							transcript = generated.trim();
							ctx.mediaStore.updateMediaTranscript(ctx.chatId, meta.id, transcript);
						}
					}
				}
				if (!transcript) {
					throw new Error(
						`This session ${meta.kind} (${meta.filename}) has no subtitles or transcript available. Only audio/video with readable subtitles or transcription (configure Deepgram or OpenAI key) can be used by the agent in a lesson.`,
					);
				}
				const details: ShowMediaDetails = {
					source: "local",
					mediaId: meta.id,
					kind: meta.kind,
					mimeType: meta.mimeType,
					filename: meta.filename,
					...(caption ? { caption } : {}),
					...(startSec !== undefined ? { startSec } : {}),
					...(endSec !== undefined ? { endSec } : {}),
					transcript,
				};
				return {
					text: `Shown session ${meta.kind}: ${meta.filename}${formatRangeNote(startSec, endSec)}.\nSubtitles/Transcript:\n${transcript}`,
					details,
				};
			}

			// Local file path
			const absolute = resolveSourcePath(input.path!);
			const bytes = await readBoundedLocalMedia(absolute, signal);
			signal?.throwIfAborted();
			const extMime = mediaMimeFromFilename(absolute);
			const sniffed = sniffAudioVideoMime(bytes);
			const mimeType =
				sniffed && extMime && (
					(sniffed === "video/webm" && (extMime === "audio/webm" || extMime === "video/webm")) ||
					(sniffed === "audio/ogg" && (extMime === "audio/ogg" || extMime === "video/ogg")) ||
					(sniffed === "video/mp4" && (extMime === "audio/mp4" || extMime === "video/mp4" || extMime === "video/quicktime"))
				)
					? extMime
					: (sniffed ?? extMime);
			const kind = mimeType ? mediaKindFromMime(mimeType) : null;
			if (!mimeType || (kind !== "audio" && kind !== "video")) {
				throw new Error(`Unsupported audio/video file: ${path.basename(absolute)}. Supported formats: mp3, wav, m4a, ogg, flac, aac, mp4, webm, mov.`);
			}

			// Require subtitles from explicit/sibling .vtt/.srt OR STT transcription.
			const localSubs = await loadLocalSubtitles(absolute, {
				subtitlePath: input.subtitlePath,
				startSec,
				endSec,
				signal,
			});
			let transcript = localSubs?.transcript ?? "";
			if (!transcript && ctx.transcribeMedia) {
				const generated = await ctx.transcribeMedia(bytes, mimeType, path.basename(absolute), signal);
				if (generated?.trim()) transcript = generated.trim();
			}
			if (!transcript) {
				throw new Error(
					`No subtitles or transcript available for ${path.basename(absolute)}. Local audio/video requires a sibling/explicit .vtt or .srt subtitle file, or a configured STT key (Deepgram/OpenAI), before the agent can use it in a lesson.`,
				);
			}

			const stored = ctx.mediaStore.saveMedia(ctx.chatId, bytes, {
				kind,
				mimeType,
				filename: path.basename(absolute),
			});
			ctx.mediaStore.updateMediaTranscript(ctx.chatId, stored.id, transcript);

			const details: ShowMediaDetails = {
				source: "local",
				mediaId: stored.id,
				kind,
				mimeType: stored.mimeType,
				filename: stored.filename,
				path: absolute,
				...(caption ? { caption } : {}),
				...(startSec !== undefined ? { startSec } : {}),
				...(endSec !== undefined ? { endSec } : {}),
				transcript,
			};
			return {
				text: `Shown ${kind} to the learner: ${stored.filename}${formatRangeNote(startSec, endSec)}.\nSubtitles/Transcript:\n${transcript}`,
				details,
			};
		}),
	};
}

"use client";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
	MAX_MEDIA_ATTACHMENTS_PER_MESSAGE,
	MAX_VIDEO_KEYFRAMES,
	maxBytesForMediaKind,
	mediaKindFromMime,
	mediaMimeFromFilename,
	normalizeMediaMimeType,
	type MediaAttachment,
	type MediaKind,
} from "@/src/core";

export interface PendingMediaItem {
	localId: string;
	kind: MediaKind;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	status: "preparing" | "ready" | "error";
	error?: string;
	previewUrl?: string;
	image?: ImageContent;
	attachment?: MediaAttachment;
	keyframes?: ImageContent[];
}

export function detectClientMediaType(file: Pick<File, "type" | "name">): { kind: MediaKind; mimeType: string } | null {
	const mimeType = normalizeMediaMimeType(file.type) ?? mediaMimeFromFilename(file.name);
	if (!mimeType) return null;
	const kind = mediaKindFromMime(mimeType);
	if (!kind) return null;
	return { kind, mimeType };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * Prepare an image file for inline native submission. Large images (> 4 MiB)
 * are downscaled client-side via canvas to keep JSON payloads responsive;
 * server-side `prepareSubmissionImages` still performs canonical validation/resizing.
 */
async function prepareImageFile(file: File, mimeType: string): Promise<{ image: ImageContent; previewUrl: string }> {
	const previewUrl = URL.createObjectURL(file);
	const needsClientShrink = file.size > 4 * 1024 * 1024 && mimeType !== "image/gif";
	if (needsClientShrink && typeof document !== "undefined") {
		try {
			const bitmap = await loadHtmlImage(previewUrl);
			const maxDim = 2048;
			const scale = Math.min(1, maxDim / Math.max(bitmap.naturalWidth || 1, bitmap.naturalHeight || 1));
			const width = Math.max(1, Math.round(bitmap.naturalWidth * scale));
			const height = Math.max(1, Math.round(bitmap.naturalHeight * scale));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (ctx) {
				ctx.drawImage(bitmap, 0, 0, width, height);
				const outMime = mimeType === "image/png" ? "image/png" : "image/jpeg";
				const dataUrl = canvas.toDataURL(outMime, 0.85);
				const base64 = dataUrl.split(",")[1];
				if (base64) {
					return { image: { type: "image", data: base64, mimeType: outMime }, previewUrl };
				}
			}
		} catch {
			// Fall back to raw bytes below if canvas decode fails.
		}
	}
	const buffer = await file.arrayBuffer();
	return {
		image: { type: "image", data: arrayBufferToBase64(buffer), mimeType },
		previewUrl,
	};
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Could not decode image"));
		img.src = url;
	});
}

function readAudioDuration(file: File): Promise<number | undefined> {
	if (typeof document === "undefined") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const audio = document.createElement("audio");
		audio.preload = "metadata";
		const finish = (duration?: number) => {
			clearTimeout(timer);
			audio.removeAttribute("src");
			audio.load();
			URL.revokeObjectURL(url);
			resolve(duration !== undefined && Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 100) / 100 : undefined);
		};
		const timer = setTimeout(() => finish(undefined), 5_000);
		audio.onloadedmetadata = () => finish(audio.duration);
		audio.onerror = () => finish(undefined);
		audio.src = url;
	});
}

/**
 * Browser-side video keyframe extraction via hidden <video> + <canvas>.
 * Captures up to `maxFrames` evenly spaced JPEG frames (max 1024px wide) so
 * any vision-capable LLM can see the video without requiring server ffmpeg.
 */
async function extractVideoMetadataAndKeyframes(
	file: File,
	maxFrames = MAX_VIDEO_KEYFRAMES,
): Promise<{ keyframes: ImageContent[]; durationSec?: number; width?: number; height?: number }> {
	if (typeof document === "undefined") return { keyframes: [] };
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	video.src = url;

	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Video metadata timeout")), 8_000);
			video.onloadeddata = () => { clearTimeout(timer); resolve(); };
			video.onerror = () => { clearTimeout(timer); reject(new Error("Video decode error")); };
		});

		const durationSec = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 100) / 100 : undefined;
		const width = video.videoWidth || undefined;
		const height = video.videoHeight || undefined;
		if (!width || !height) return { keyframes: [], durationSec };

		const maxDim = 1024;
		const scale = Math.min(1, maxDim / Math.max(width, height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) return { keyframes: [], durationSec, width, height };

		const sampleTimes: number[] = [];
		if (!durationSec || durationSec < 1) {
			sampleTimes.push(0);
		} else {
			const count = Math.min(maxFrames, Math.max(1, Math.ceil(durationSec / 4)));
			for (let i = 0; i < count; i++) {
				const fraction = count === 1 ? 0.25 : 0.1 + (0.8 * i) / (count - 1);
				sampleTimes.push(Math.min(durationSec - 0.05, Math.max(0, durationSec * fraction)));
			}
		}

		const keyframes: ImageContent[] = [];
		for (const t of sampleTimes) {
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("Seek timeout")), 4_000);
					const done = () => { clearTimeout(timer); resolve(); };
					video.onseeked = done;
					video.onerror = () => { clearTimeout(timer); reject(new Error("Seek failed")); };
					if (Math.abs(video.currentTime - t) < 0.05) {
						done();
					} else {
						video.currentTime = t;
					}
				});
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
				const base64 = dataUrl.split(",")[1];
				if (base64) {
					keyframes.push({ type: "image", data: base64, mimeType: "image/jpeg" });
				}
			} catch {
				// Keep already-captured frames on single seek failure.
			}
		}

		return { keyframes, durationSec, width, height };
	} catch {
		return { keyframes: [] };
	} finally {
		video.pause();
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}

export async function prepareMediaFileForChat(
	chatId: string,
	file: File,
	signal?: AbortSignal,
): Promise<Omit<PendingMediaItem, "localId">> {
	const detected = detectClientMediaType(file);
	if (!detected) {
		throw new Error(`Unsupported file type: ${file.name}. Attach an image, audio, or video file.`);
	}
	const limit = maxBytesForMediaKind(detected.kind);
	if (file.size === 0) throw new Error(`${file.name} is empty.`);
	if (file.size > limit) {
		throw new Error(`${file.name} exceeds the ${Math.round(limit / (1024 * 1024))} MiB limit.`);
	}

	if (detected.kind === "image") {
		const { image, previewUrl } = await prepareImageFile(file, detected.mimeType);
		return {
			kind: "image",
			filename: file.name || "image",
			mimeType: image.mimeType,
			sizeBytes: file.size,
			status: "ready",
			previewUrl,
			image,
		};
	}

	// Upload audio/video binary to session MediaStore first.
	const form = new FormData();
	form.append("file", file, file.name || `upload.${detected.kind}`);
	const uploadRes = await fetch(`/api/chats/${encodeURIComponent(chatId)}/media`, {
		method: "POST",
		body: form,
		signal,
	});
	if (!uploadRes.ok) {
		const err = (await uploadRes.json().catch(() => ({}))) as { error?: string };
		throw new Error(err.error ?? `Failed to upload ${file.name} (${uploadRes.status}).`);
	}
	const { media: uploaded } = (await uploadRes.json()) as { media: MediaAttachment };

	// In parallel: extract local metadata/keyframes + best-effort STT transcription.
	const transcribePromise = fetch("/api/stt/transcribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, mediaId: uploaded.id }),
		signal,
	})
		.then(async (res) => (res.ok ? ((await res.json()) as { transcript?: string | null }) : { transcript: null }))
		.catch(() => ({ transcript: null }));

	if (detected.kind === "audio") {
		const [durationSec, stt] = await Promise.all([readAudioDuration(file), transcribePromise]);
		const attachment: MediaAttachment = {
			...uploaded,
			...(durationSec !== undefined ? { durationSec } : {}),
			...(stt.transcript ? { transcript: stt.transcript } : {}),
		};
		return {
			kind: "audio",
			filename: attachment.filename,
			mimeType: attachment.mimeType,
			sizeBytes: attachment.sizeBytes,
			status: "ready",
			attachment,
		};
	}

	// Video: browser keyframes + dimensions + duration + best-effort STT transcript
	const [videoMeta, stt] = await Promise.all([extractVideoMetadataAndKeyframes(file), transcribePromise]);
	const attachment: MediaAttachment = {
		...uploaded,
		...(videoMeta.durationSec !== undefined ? { durationSec: videoMeta.durationSec } : {}),
		...(videoMeta.width !== undefined ? { width: videoMeta.width } : {}),
		...(videoMeta.height !== undefined ? { height: videoMeta.height } : {}),
		...(stt.transcript ? { transcript: stt.transcript } : {}),
		...(videoMeta.keyframes.length ? { keyframeCount: videoMeta.keyframes.length } : {}),
	};
	return {
		kind: "video",
		filename: attachment.filename,
		mimeType: attachment.mimeType,
		sizeBytes: attachment.sizeBytes,
		status: "ready",
		attachment,
		keyframes: videoMeta.keyframes,
	};
}

export { MAX_MEDIA_ATTACHMENTS_PER_MESSAGE };

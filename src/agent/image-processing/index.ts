// Ported from @earendil-works/pi-coding-agent 1.1.0, dist/utils/image-process.js (MIT).
import { convertImageBytesToPng } from "./convert.mjs";
import { formatDimensionNote, resizeImage } from "./resize.ts";
import type { ProcessImageOptions, ProcessImageResult } from "./types.ts";

export { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "./mime.mjs";
export type { ModelImageResizeOptions, ProcessImageOptions, ProcessImageResult, ResizedImage, SupportedImageMimeType } from "./types.ts";

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png": return "image/png";
		case "image/jpeg":
		case "image/jpg": return "image/jpeg";
		case "image/gif": return "image/gif";
		case "image/webp": return "image/webp";
		default: return null;
	}
}

async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<{ bytes: Uint8Array; mimeType: string; convertedFrom?: string } | null> {
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	if (normalizedMimeType) return { bytes, mimeType: normalizedMimeType };
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) return null;
	return { bytes: pngBytes, mimeType: "image/png", convertedFrom: baseMimeType(mimeType) };
}

function conversionHint(from: string | undefined, to: string): string | undefined {
	if (!from || from === to) return undefined;
	return `[Image converted from ${from} to ${to}.]`;
}

export async function processImage(bytes: Uint8Array, mimeType: string, options?: ProcessImageOptions): Promise<ProcessImageResult> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized = await normalizeImage(bytes, mimeType);
	if (!normalized) {
		return { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" };
	}
	if (autoResizeImages) {
		const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		if (!resized) {
			return { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" };
		}
		const hints: string[] = [];
		const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
		if (convertedHint) hints.push(convertedHint);
		const dimensionNote = formatDimensionNote(resized);
		if (dimensionNote) hints.push(dimensionNote);
		return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
	}
	const hints: string[] = [];
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);
	return { ok: true, data: Buffer.from(normalized.bytes).toString("base64"), mimeType: normalized.mimeType, hints };
}

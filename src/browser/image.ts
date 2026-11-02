/**
 * Image conversion + resizing for the phone build (mobile Phase 4). The
 * desktop uses Photon (a native/WASM image library) in a worker thread;
 * the browser decodes images itself (createImageBitmap — on iOS that
 * includes HEIC photos) and re-encodes on a canvas. Same contract and same
 * strategy as src/agent/image-processing/resize-core.mjs: keep the
 * original when it already fits; else scale to the max box and try PNG,
 * then JPEG qualities, shrinking the dimensions until it fits maxBytes.
 *
 * scripts/build-mobile.mjs points image-processing's "./resize.ts" and
 * "./convert.mjs" imports here.
 */
import type { ModelImageResizeOptions, ResizedImage } from "../agent/image-processing/types.ts";
import { Buffer } from "./shims/buffer.ts";

const DEFAULTS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80 };

async function decode(bytes: Uint8Array): Promise<ImageBitmap | null> {
	try {
		// "from-image" applies EXIF orientation, like the desktop's EXIF step.
		return await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" });
	} catch {
		return null;
	}
}

async function encode(bitmap: ImageBitmap, width: number, height: number, type: string, quality?: number): Promise<Uint8Array | null> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.imageSmoothingQuality = "high";
	if (type === "image/jpeg") {
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
	}
	ctx.drawImage(bitmap, 0, 0, width, height);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality === undefined ? undefined : quality / 100));
	return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const base64 = (bytes: Uint8Array) => Buffer.wrap(bytes).toString("base64");

/** convert.mjs's contract: any decodable image → PNG bytes, or null. */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const bitmap = await decode(bytes);
	if (!bitmap) return null;
	try {
		return await encode(bitmap, bitmap.width, bitmap.height, "image/png");
	} finally {
		bitmap.close();
	}
}

export async function resizeImage(inputBytes: Uint8Array, mimeType: string, options?: ModelImageResizeOptions): Promise<ResizedImage | null> {
	const opts = { ...DEFAULTS, ...options };
	const bitmap = await decode(inputBytes);
	if (!bitmap) return null;
	try {
		const originalWidth = bitmap.width;
		const originalHeight = bitmap.height;
		const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: base64(inputBytes),
				mimeType: mimeType || "image/png",
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}
		let width = originalWidth;
		let height = originalHeight;
		if (width > opts.maxWidth) {
			height = Math.round((height * opts.maxWidth) / width);
			width = opts.maxWidth;
		}
		if (height > opts.maxHeight) {
			width = Math.round((width * opts.maxHeight) / height);
			height = opts.maxHeight;
		}
		const qualities = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		for (;;) {
			const attempts: [string, number | undefined][] = [["image/png", undefined], ...qualities.map((q): [string, number] => ["image/jpeg", q])];
			for (const [type, quality] of attempts) {
				const bytes = await encode(bitmap, width, height, type, quality);
				if (!bytes) continue;
				const data = base64(bytes);
				if (data.length < opts.maxBytes) {
					return { data, mimeType: type, originalWidth, originalHeight, width, height, wasResized: true };
				}
			}
			if (width === 1 && height === 1) return null;
			width = Math.max(1, Math.floor(width * 0.75));
			height = Math.max(1, Math.floor(height * 0.75));
		}
	} finally {
		bitmap.close();
	}
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) return undefined;
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

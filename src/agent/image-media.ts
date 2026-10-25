import {
	checkImageDimensions,
	inspectImageBytes,
	IMAGE_ERRORS,
	ImageInputError,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGES,
	MAX_SOURCE_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	type ComposerImage,
	type InspectedImage,
} from "../core/images.ts";

/**
 * Server-side image media: the one place agent tools (read, pdf_view) and
 * the chat input path decode, bound and re-encode images. Uses the
 * existing @napi-rs/canvas (Skia) host, no new dependency. Pure PNG
 * canonicalization (providerSafePng) lives here so headless.ts can import
 * it without a cycle (headless re-exports it).
 */

/** Read a whole file but never more than maxBytes: chunked from an open
 *  handle (no size-sized allocation up front, no stat/read TOCTOU), and
 *  one extra byte is requested so growth past the cap is detected. Throws
 *  `tooLarge()`'s error when the file exceeds maxBytes. */
export async function readBoundedFile(
	file: string,
	maxBytes: number,
	tooLarge: () => Error,
	signal?: AbortSignal,
): Promise<Buffer> {
	const { open } = await import("node:fs/promises");
	const handle = await open(file, "r");
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		const CHUNK = 1024 * 1024;
		for (;;) {
			throwIfAborted(signal);
			const want = Math.min(CHUNK, maxBytes + 1 - total);
			const buf = Buffer.allocUnsafe(want);
			const { bytesRead } = await handle.read(buf, 0, want, total);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes) throw tooLarge();
			chunks.push(bytesRead === want ? buf : buf.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, total);
	} finally {
		await handle.close();
	}
}

/** Image-sized bounded read (20 MiB source cap). */
export function readBoundedImageFile(file: string, signal?: AbortSignal): Promise<Buffer> {
	return readBoundedFile(file, MAX_SOURCE_IMAGE_BYTES, () => new ImageInputError(`Image file is too large (${MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)} MiB max).`), signal);
}

export type NormalizedImage = { type: "image"; data: string; mimeType: "image/png" };

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** Decode with Skia, rejecting anything the header sniff did not predict. */
async function decode(bytes: Uint8Array, info: InspectedImage) {
	const { loadImage } = await import("@napi-rs/canvas");
	let img;
	try {
		img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	} catch {
		throw new ImageInputError(IMAGE_ERRORS.unreadable);
	}
	// Skia applies EXIF orientation, so a rotated JPEG decodes with its
	// header sides swapped (same pixels). Accept that for JPEG only.
	const same = img.width === info.width && img.height === info.height;
	const swapped = info.mimeType === "image/jpeg" && img.width === info.height && img.height === info.width;
	if (!same && !swapped) throw new ImageInputError(IMAGE_ERRORS.content);
	return img;
}

/** Normalize any supported image to a bounded PNG block: sniffed by
 *  content, source <= 20 MiB, <= 25 MP, longest side <= 2048, <= 5 MiB. */
export async function normalizeImage(bytes: Uint8Array, signal?: AbortSignal): Promise<NormalizedImage> {
	throwIfAborted(signal);
	if (bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
		throw new ImageInputError(`Image file is too large (${MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)} MiB max).`);
	}
	const info = inspectImageBytes(bytes);
	if (!info) throw new ImageInputError(IMAGE_ERRORS.format);
	checkImageDimensions(info.width, info.height);
	const img = await decode(bytes, info);
	throwIfAborted(signal);
	const { createCanvas } = await import("@napi-rs/canvas");
	// Output geometry follows the DECODED (orientation-applied) image.
	const sw = img.width;
	const sh = img.height;
	let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(sw, sh));
	for (let attempt = 0; attempt < 8; attempt++) {
		const w = Math.max(1, Math.round(sw * scale));
		const h = Math.max(1, Math.round(sh * scale));
		const canvas = createCanvas(w, h);
		canvas.getContext("2d").drawImage(img, 0, 0, w, h);
		const png = providerSafePng(await canvas.encode("png"));
		throwIfAborted(signal);
		if (png.byteLength <= MAX_IMAGE_BYTES) return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
		scale *= 0.75;
	}
	throw new ImageInputError(IMAGE_ERRORS.size);
}

/** Fully decode and bounds-check composer images WITHOUT changing their
 *  bytes (the optimistic copy must equal the server's write-ahead copy). */
export async function validateInputImages(images: readonly ComposerImage[]): Promise<void> {
	if (images.length > MAX_IMAGES) throw new ImageInputError(IMAGE_ERRORS.count);
	let total = 0;
	for (const image of images) {
		if (image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
			throw new ImageInputError(IMAGE_ERRORS.shape);
		}
		const bytes = Buffer.from(image.data, "base64");
		if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.size);
		total += bytes.byteLength;
		if (total > MAX_TOTAL_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.total);
		const info = inspectImageBytes(bytes);
		if (!info || info.mimeType === "image/bmp") throw new ImageInputError(IMAGE_ERRORS.format);
		if (info.mimeType !== image.mimeType) throw new ImageInputError(IMAGE_ERRORS.content);
		checkImageDimensions(info.width, info.height);
		await decode(bytes, info);
	}
}

// ─── canonical PNG (moved from headless.ts, which re-exports it) ──────────

/** Canonicalize a PNG for provider vision decoders: merge a split IDAT
 *  stream into the single-chunk form (byte-identical zlib stream, no
 *  re-encoding). Chrome writes 4KB IDAT chunks that Alibaba's decoder
 *  (qwen vision behind OpenRouter) rejected on 2026-09-18/19. Pure Node on
 *  purpose: one native image lib per process. */
export function providerSafePng(png: Buffer): Buffer {
	const SIG_LEN = 8;
	if (png.length < SIG_LEN + 12 || png.subarray(0, SIG_LEN).toString("hex") !== "89504e470d0a1a0a") return png;
	const parts: Array<{ type: string; data: Buffer }> = [];
	let off = SIG_LEN;
	while (off + 12 <= png.length) {
		const len = png.readUInt32BE(off);
		if (off + 12 + len > png.length) break; // truncated tail, leave as-is
		parts.push({ type: png.subarray(off + 4, off + 8).toString("ascii"), data: png.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	const idats = parts.filter((p) => p.type === "IDAT");
	if (idats.length < 2) return png; // already canonical
	const merged = Buffer.concat(idats.map((p) => p.data));
	let emittedIdat = false;
	const out: Buffer[] = [png.subarray(0, SIG_LEN)];
	for (const p of parts) {
		if (p.type !== "IDAT") out.push(chunk(p.type, p.data));
		else if (!emittedIdat) {
			out.push(chunk("IDAT", merged));
			emittedIdat = true;
		}
	}
	return Buffer.concat(out);
}

/** One PNG chunk (length + type + data + CRC32). */
function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

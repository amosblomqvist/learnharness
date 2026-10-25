/**
 * NATIVE CHAT IMAGES (docs/images.md).
 *
 * The learner attaches an image in the composer; it rides the EXISTING
 * text input event as native pi ImageContent blocks inside the user
 * message (no attachment store, no second history). These rules are the
 * trust boundary: the composer runs them for an early, kind refusal, and
 * the server runs the same ones for a 400 before the write-ahead appends
 * anything (input-events.parseChatInput).
 *
 * Pure and browser-safe (no node:fs).
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { ChatInputError } from "./input-error.ts";

/** One pasted image (native pi shape, base64 without a data: prefix). */
export type ComposerImage = ImageContent;

/** A composer draft image: the wire shape plus the client identity the
 *  preview strip's remove button keys on. */
export interface DraftImage extends ComposerImage {
	id: string;
}

/** The session title when the first message is a picture with no words
 *  (sessions are titled from their first message). */
export const IMAGE_ONLY_TITLE = "Pasted image";
/** The refusal code when the conversation model cannot read images. */
export const MODEL_CANNOT_READ_IMAGES_CODE = "model_cannot_read_images" as const;

export const MAX_IMAGES = 4;
/** Shared raster bounds for local input, PDF crops and agent image tools. */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
/** The resize target for sources and agent tools (not a wire rejection limit). */
export const MAX_IMAGE_DIMENSION = 2048;
/** Hard per-side decode ceiling, in addition to the pixel count. This
 *  bounds pathological thin images before the decoder allocates pixels. */
export const MAX_WIRE_IMAGE_SIDE = 16_384;
/** Per-image decoded size (5 MB: a full-screen retina screenshot fits). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Whole-message decoded size: the record is JSON, keep the write bounded. */
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The refusal wording, single-sourced: the composer's inline line and the
 *  server's 400 read the same text. */
export const IMAGE_ERRORS = {
	format: "Images must be PNG, JPEG, WebP, or GIF.",
	size: `Each image must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`,
	count: `You can attach up to ${MAX_IMAGES} images.`,
	total: `Those images are too large together (${MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)} MB max).`,
	content: "That file is not the image it claims to be.",
	unreadable: "That image could not be read.",
	shape: "Each image must be an image block with base64 data.",
	dimensions: "That image has invalid or oversized dimensions.",
	source: `Image files must be ${MAX_SOURCE_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`,
} as const;

/** A malformed image payload: the server's honest 400 (it IS a
 *  ChatInputError) and the composer's inline hint. */
export class ImageInputError extends ChatInputError {}

/** THE image block constructor. One key order everywhere: the optimistic
 *  transcript copy is matched to the server's write-ahead copy by JSON
 *  (session-core absorbed), so every block must be built here. */
export function imageBlock(mimeType: string, data: string): ComposerImage {
	return { type: "image", data, mimeType };
}

/** The wire shape of draft images: only the native fields cross the wire
 *  (the draft's client id stays in the browser). */
export function wireImages(images: readonly ComposerImage[]): ComposerImage[] {
	return images.map((i) => imageBlock(i.mimeType, i.data));
}

/** The preview / transcript src for an image block. */
export function imageUrl(image: ComposerImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

const RASTER_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,[A-Za-z0-9+/]{16,}/;

/** Inspect only the header, not a multi-megabyte payload, on render. */
export function rasterMimeOf(url: string): string | null {
	return RASTER_DATA_URL.exec(url.slice(0, 160))?.[1] ?? null;
}

export function isRasterDataUrl(url: unknown): url is string {
	return typeof url === "string" && url.length <= 40_000_000 && rasterMimeOf(url) !== null;
}

export function imageFileName(url: string): string {
	const mime = rasterMimeOf(url) ?? "image/png";
	return "image." + (mime === "image/jpeg" ? "jpg" : mime.slice(6));
}

/** The pre-read check for WIRE images (what the composer sends after any
 *  resize): the declared format and the decoded size, 5 MB max. */
export function checkImageMeta(mimeType: string, bytes: number): void {
	if (!IMAGE_MIMES.has(mimeType)) throw new ImageInputError(IMAGE_ERRORS.format);
	if (bytes > MAX_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.size);
}

/** The pre-read check for a raw SOURCE file (before the composer resizes or
 *  re-encodes it for the wire): same formats, 20 MB max. */
export function checkSourceImageMeta(mimeType: string, bytes: number): void {
	if (!IMAGE_MIMES.has(mimeType)) throw new ImageInputError(IMAGE_ERRORS.format);
	if (bytes > MAX_SOURCE_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.source);
}

/** Reject zero, non-integer, per-side-huge and too-many-pixel rasters
 *  (called before any decode, from header-read dimensions). */
export function checkImageDimensions(width: number, height: number): void {
	const ok = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
	if (!ok || width > MAX_WIRE_IMAGE_SIDE || height > MAX_WIRE_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
		throw new ImageInputError(IMAGE_ERRORS.dimensions);
	}
}

// ─── header inspection (pure, no decoder) ────────────────────────────────────

export interface InspectedImage {
	mimeType: string;
	width: number;
	height: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number) => ((b[o + 3]! << 24) | (b[o + 2]! << 16) | (b[o + 1]! << 8) | b[o]!) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(b: Uint8Array): [number, number] | null {
	if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) return null;
	if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return null;
	return [u32be(b, 16), u32be(b, 20)];
}

function jpegSize(b: Uint8Array): [number, number] | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
	let i = 2;
	while (i + 3 < b.length) {
		if (b[i] !== 0xff) return null;
		let marker = b[i + 1]!;
		while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]!; } // fill bytes
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
		if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any frame header
		const len = u16be(b, i + 2);
		if (len < 2) return null;
		// SOF0-3, 5-7, 9-11, 13-15 (baseline, extended, progressive, lossless, arithmetic)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (len < 8 || i + 9 > b.length) return null;
			return [u16be(b, i + 7), u16be(b, i + 5)];
		}
		i += 2 + len;
	}
	return null;
}

function gifSize(b: Uint8Array): [number, number] | null {
	if (b.length < 10) return null;
	const sig = ascii(b, 0, 6);
	return sig === "GIF87a" || sig === "GIF89a" ? [u16le(b, 6), u16le(b, 8)] : null;
}

function webpSize(b: Uint8Array): [number, number] | null {
	if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
	const kind = ascii(b, 12, 4);
	if (kind === "VP8X") return [u24le(b, 24) + 1, u24le(b, 27) + 1];
	if (kind === "VP8L") {
		if (b[20] !== 0x2f) return null;
		const bits = u32le(b, 21);
		return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
	}
	if (kind === "VP8 ") {
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
	}
	return null;
}

function bmpSize(b: Uint8Array): [number, number] | null {
	if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
	const header = u32le(b, 14);
	if (header === 12) return [u16le(b, 18), u16le(b, 20)];
	if (header < 40) return null;
	const w = u32le(b, 18) | 0;
	const h = u32le(b, 22) | 0;
	return [Math.abs(w), Math.abs(h)];
}

/** THE shared header reader (browser-safe, no decoder): PNG (full signature
 *  + IHDR), JPEG (SOF scan incl. progressive), GIF, WebP (VP8/VP8L/VP8X)
 *  and BMP (legacy tool-read only; never a user-image format). Null for
 *  anything unrecognised, truncated, or with a zero dimension. Dimensions
 *  are returned as-read: the caller applies its own ceilings
 *  (checkImageDimensions). */
export function inspectImageBytes(bytes: Uint8Array): InspectedImage | null {
	const probes: Array<[string, (b: Uint8Array) => [number, number] | null]> = [
		["image/png", pngSize],
		["image/jpeg", jpegSize],
		["image/gif", gifSize],
		["image/webp", webpSize],
		["image/bmp", bmpSize],
	];
	for (const [mimeType, probe] of probes) {
		const size = probe(bytes);
		if (size === null) continue;
		const [width, height] = size;
		return width > 0 && height > 0 ? { mimeType, width, height } : null;
	}
	return null;
}

// ─── payload validation ──────────────────────────────────────────────────────

/** Encoded-length ceiling for one wire image, checked BEFORE any regex. */
const MAX_ENCODED_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Strict canonical base64: standard alphabet, length % 4 === 0, padding
 *  only at the end, and zero trailing bits (one string per byte string). */
const BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/; // flat: a grouped pattern overflows the stack on MiB input
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isCanonicalBase64(data: string): boolean {
	if (data.length === 0 || data.length % 4 !== 0 || data.length > MAX_ENCODED_IMAGE_CHARS) return false;
	if (!BASE64_CHARS.test(data)) return false;
	if (data.endsWith("==")) return (B64.indexOf(data[data.length - 3]!) & 0x0f) === 0;
	if (data.endsWith("=")) return (B64.indexOf(data[data.length - 2]!) & 0x03) === 0;
	return true;
}

/** Decoded byte length of canonical base64 text, without decoding it. */
function decodedBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Validate an image payload: count, shape, canonical base64, caps, then
 *  the content itself (header magic + dimensions agree with the declared
 *  type, bounded). Returns fresh blocks with the bytes untouched (no
 *  re-encode, no dedupe). Refusals are fixed wording, never an echo of
 *  the payload. */
export function parseComposerImages(value: unknown): ComposerImage[] {
	if (!Array.isArray(value)) throw new ImageInputError(IMAGE_ERRORS.shape);
	if (value.length > MAX_IMAGES) throw new ImageInputError(IMAGE_ERRORS.count);
	const blocks = value.map(checkShape);
	// Totals from encoded lengths first: nothing is decoded past the caps.
	let total = 0;
	for (const b of blocks) {
		if (!isCanonicalBase64(b.data)) throw new ImageInputError(b.data.length > MAX_ENCODED_IMAGE_CHARS ? IMAGE_ERRORS.size : IMAGE_ERRORS.shape);
		total += decodedBytes(b.data);
	}
	if (total > MAX_TOTAL_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.total);
	return blocks.map(checkContent);
}

function checkShape(value: unknown): ComposerImage {
	const v = (value ?? {}) as Record<string, unknown>;
	if (v.type !== "image" || typeof v.mimeType !== "string" || typeof v.data !== "string") {
		throw new ImageInputError(IMAGE_ERRORS.shape);
	}
	checkImageMeta(v.mimeType, 0);
	// Size is judged on the encoded length first (cheap, pre-regex).
	if (v.data.length > MAX_ENCODED_IMAGE_CHARS) throw new ImageInputError(IMAGE_ERRORS.size);
	return imageBlock(v.mimeType, v.data);
}

function checkContent(image: ComposerImage): ComposerImage {
	checkImageMeta(image.mimeType, decodedBytes(image.data));
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(image.data);
	} catch {
		throw new ImageInputError(IMAGE_ERRORS.shape);
	}
	const info = inspectImageBytes(bytes);
	if (info === null || info.mimeType !== image.mimeType) throw new ImageInputError(IMAGE_ERRORS.content);
	checkImageDimensions(info.width, info.height);
	return image;
}

// ─── text projections (summary + export) ─────────────────────────────────────

const IMAGE_MIME = /^image\/[\w.+-]{1,32}$/;

/** The informative placeholder for an image in summaries and logs: the type
 *  only, NEVER the base64. */
export function imageMarker(image: { mimeType?: unknown }): string {
	return `[Image ${typeof image.mimeType === "string" && IMAGE_MIME.test(image.mimeType) ? image.mimeType : "unknown"}]`;
}

/** An image as markdown (`![alt](data:...)`). Falls back to the plain marker
 *  when the block is not a well-formed image (nothing unsafe in a link). */
export function imageDataUrlMarkdown(image: { mimeType?: unknown; data?: unknown }, alt = "Image"): string {
	const { mimeType, data } = image;
	if (typeof mimeType === "string" && typeof data === "string" && IMAGE_MIME.test(mimeType) && BASE64_CHARS.test(data)) {
		return `![${alt.replace(/[[\]\n]/g, " ")}](data:${mimeType};base64,${data})`;
	}
	return imageMarker(image);
}

/**
 * COMPOSER IMAGES (spec: docs/superpowers/plans/2026-10-24-chat-image-paste-spec-and-plan.md).
 *
 * The learner pastes a screenshot into the composer; it rides the EXISTING
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

const MAX_IMAGES = 4;
/** Per-image decoded size (5 MB: a full-screen retina screenshot fits). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Whole-message decoded size: the record is JSON, keep the write bounded. */
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The accepted formats and the bytes each file starts with (its signature,
 * as [offset, expected bytes] pairs). The declared MIME type is the
 * client's claim; the signature is the content's.
 */
const SIGNATURES: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>> = {
	"image/png": [[0, "\x89PNG"]],
	"image/jpeg": [[0, "\xff\xd8\xff"]],
	"image/gif": [[0, "GIF8"]],
	"image/webp": [[0, "RIFF"], [8, "WEBP"]],
};

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

/** The pre-read check (the composer refuses before reading a file): the
 *  declared format and the decoded size. */
export function checkImageMeta(mimeType: string, bytes: number): void {
	if (!(mimeType in SIGNATURES)) throw new ImageInputError(IMAGE_ERRORS.format);
	if (bytes > MAX_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.size);
}

/** Validate an image payload: count, shape, format, sizes, and content. */
export function parseComposerImages(value: unknown): ComposerImage[] {
	if (!Array.isArray(value)) throw new ImageInputError(IMAGE_ERRORS.shape);
	if (value.length > MAX_IMAGES) throw new ImageInputError(IMAGE_ERRORS.count);
	const images = value.map(checkImage);
	const total = images.reduce((n, i) => n + decodedBytes(i.data), 0);
	if (total > MAX_TOTAL_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERRORS.total);
	return images;
}

const BASE64 = /^[A-Za-z0-9+/]{16,}={0,2}$/;

function checkImage(value: unknown): ComposerImage {
	if (!isImageBlock(value)) throw new ImageInputError(IMAGE_ERRORS.shape);
	checkImageMeta(value.mimeType, decodedBytes(value.data));
	if (!startsWithSignature(value.mimeType, value.data)) throw new ImageInputError(IMAGE_ERRORS.content);
	return imageBlock(value.mimeType, value.data);
}

function isImageBlock(value: unknown): value is ComposerImage {
	const v = (value ?? {}) as Record<string, unknown>;
	return v.type === "image" && typeof v.mimeType === "string" && typeof v.data === "string" && BASE64.test(v.data);
}

/** Decoded byte length of base64 text, without decoding it. */
function decodedBytes(data: string): number {
	const padding = data.length - data.replace(/=+$/, "").length;
	return Math.floor((data.length * 3) / 4) - padding;
}

/** Decodes only the first 12 bytes (16 base64 chars): enough for every signature. */
function startsWithSignature(mimeType: string, data: string): boolean {
	const head = atob(data.slice(0, 16));
	return SIGNATURES[mimeType]!.every(([offset, bytes]) => head.startsWith(bytes, offset));
}

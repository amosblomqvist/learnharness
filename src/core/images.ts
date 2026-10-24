/**
 * COMPOSER IMAGES (spec: docs/superpowers/plans/2026-10-24-chat-image-paste-spec-and-plan.md).
 *
 * The learner pastes a screenshot into the composer; it rides the EXISTING
 * text input event as native pi ImageContent blocks inside the user
 * message — no attachment store, no second history. These limits are the
 * trust boundary: the client refuses early for a kind message, the server
 * refuses the same content with a 400 before the write-ahead appends
 * anything (input-events.parseChatInput).
 *
 * Pure and browser-safe (no node:fs): the browser reads clipboard files,
 * the server only re-validates the base64 it received.
 */

import type { ImageContent } from "@earendil-works/pi-ai";

/** Formats every image-capable provider accepts. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** One pasted image (native pi shape — base64 without a data: prefix). */
export type ComposerImage = ImageContent;

/** A composer draft image: the wire shape plus the client identity the
 *  preview strip's remove button keys on. */
export interface DraftImage extends ComposerImage {
	id: string;
}

export const MAX_IMAGES = 4;
/** Per-image decoded size (5 MB — a full-screen retina screenshot fits). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Whole-message decoded size: the record is JSON, keep the write bounded. */
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

/** A malformed image payload (the honest 400 / the composer's inline hint). */
export class ImageInputError extends Error {}

/** Decoded byte length of base64 text, without decoding it. */
export function imageBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length * 3) / 4) - padding;
}

/** The preview / transcript src for an image block. */
export function imageUrl(image: ComposerImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function checkImage(value: unknown): ComposerImage {
	if (typeof value !== "object" || value === null) throw new ImageInputError("Each image must be an object.");
	const v = value as Record<string, unknown>;
	if (v.type !== "image") throw new ImageInputError("Each image must have type \"image\".");
	if (typeof v.mimeType !== "string" || !(IMAGE_MIME_TYPES as readonly string[]).includes(v.mimeType)) {
		throw new ImageInputError("Images must be PNG, JPEG, WebP, or GIF.");
	}
	if (typeof v.data !== "string" || v.data.length === 0 || !BASE64.test(v.data)) {
		throw new ImageInputError("Each image must carry base64 data.");
	}
	if (imageBytes(v.data) > MAX_IMAGE_BYTES) {
		throw new ImageInputError(`Each image must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`);
	}
	return { type: "image", mimeType: v.mimeType, data: v.data };
}

/** Validate an image payload (count, formats, base64, sizes). */
export function parseComposerImages(value: unknown): ComposerImage[] {
	if (!Array.isArray(value)) throw new ImageInputError("images must be an array");
	if (value.length > MAX_IMAGES) throw new ImageInputError(`You can attach up to ${MAX_IMAGES} images.`);
	const images = value.map(checkImage);
	const total = images.reduce((n, i) => n + imageBytes(i.data), 0);
	if (total > MAX_TOTAL_IMAGE_BYTES) {
		throw new ImageInputError(`Those images are too large together (${MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)} MB max).`);
	}
	return images;
}

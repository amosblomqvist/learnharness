import * as fs from "node:fs/promises";
import { resolveSourcePath } from "./fs-shared.ts";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "../image-processing/index.ts";
import { convertImageBytesToPng } from "../image-processing/convert.mjs";
import { getExifOrientation } from "../image-processing/exif-orientation.mjs";
import { resizeImage } from "../image-processing/resize.ts";

/**
 * Learner images in the lesson (issue #363): `show_image` puts one in the
 * transcript as-is, and `visual` with an `image` path draws on top of one.
 * Both embed the picture INSIDE the session record (owner decision: the
 * lesson survives the file moving), so it is bounded here, once:
 *
 * - PNG or JPEG only — what every renderer (browser, resvg) and the
 *   ShowImageDetails contract accept;
 * - the longest side at most 1600px and about 1 MB of base64 — a file
 *   already within both is kept byte-for-byte;
 * - EXIF rotation baked into the pixels: browsers honor the tag and resvg
 *   does not, and the visual-maker must look at what the learner sees.
 *
 * Paths resolve like read's (home-anchored, fs-shared.ts); read-only.
 */

const STORED_IMAGE_LIMITS = { maxWidth: 1600, maxHeight: 1600, maxBytes: 1024 * 1024 };

const SUPPORTED = "jpg, png, gif, webp, or bmp";

export interface LearnerImage {
	/** The absolute path the image was read from. */
	path: string;
	mimeType: "image/png" | "image/jpeg";
	/** Base64 image bytes. */
	data: string;
	width: number;
	height: number;
}

/** Resolve a learner image path and sniff its type without decoding it —
 *  cheap enough for dispatch time. Returns the absolute path; throws a
 *  model-readable Error when the file is missing or not a supported image. */
export async function checkLearnerImage(rawPath: string): Promise<string> {
	const absolute = resolveSourcePath(rawPath);
	let mime: string | null;
	try {
		mime = await detectSupportedImageMimeTypeFromFile(absolute);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		const reason = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a directory" : err instanceof Error ? err.message : String(err);
		throw new Error(`Cannot open image ${absolute}: ${reason}`);
	}
	if (!mime) throw new Error(`${absolute} is not a supported image (${SUPPORTED})`);
	return absolute;
}

/** Read a learner image and bound it for storage (the module doc's rules). */
export async function loadLearnerImage(rawPath: string, signal?: AbortSignal): Promise<LearnerImage> {
	const absolute = await checkLearnerImage(rawPath);
	const bytes = new Uint8Array(await fs.readFile(absolute, { signal }));
	const mime = detectSupportedImageMimeType(bytes);
	// Upright PNG/JPEG goes straight to the resizer; anything else (other
	// formats, a rotation tag) is decoded to an upright PNG first.
	const direct = (mime === "image/png" || mime === "image/jpeg") && getExifOrientation(bytes) === 1;
	const source = direct ? bytes : await convertImageBytesToPng(bytes);
	signal?.throwIfAborted();
	if (!source) throw new Error(`Could not decode image ${absolute}`);
	const stored = await resizeImage(source, direct ? mime : "image/png", STORED_IMAGE_LIMITS);
	signal?.throwIfAborted();
	if (!stored || (stored.mimeType !== "image/png" && stored.mimeType !== "image/jpeg")) {
		throw new Error(`Could not shrink image ${absolute} to an embeddable size`);
	}
	return { path: absolute, mimeType: stored.mimeType, data: stored.data, width: stored.width, height: stored.height };
}

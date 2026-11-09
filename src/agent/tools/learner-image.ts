import * as fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { resolveSourcePath } from "./fs-shared.ts";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile, type ResizedImage } from "../image-processing/index.ts";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "./learner-image-dimensions.ts";
import type { ImageSnapshot } from "../../core/contracts.ts";

/** One bounded, upright, metadata-free snapshot; path is provenance, not identity. */
export interface LearnerImage extends ImageSnapshot {
	path: string;
	snapshotId: string;
}

export async function checkLearnerImage(rawPath: string): Promise<string> {
	// Reuse the shared file-access policy, including canonical/symlink checks.
	const absolute = resolveSourcePath(rawPath);
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) throw new Error("it is not a regular file");
		if (stat.size > MAX_LEARNER_IMAGE_BYTES) throw new Error("image exceeds 25 MiB; provide a smaller image");
		if (!await detectSupportedImageMimeTypeFromFile(absolute)) throw new Error("not a supported image (jpg, png, gif, webp, or bmp)");
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot open image ${absolute}: ${reason}`);
	}
	return absolute;
}

async function readBounded(absolute: string, signal?: AbortSignal): Promise<Uint8Array> {
	const handle = await fs.open(absolute, "r");
	try {
		if (!(await handle.stat()).isFile()) throw new Error("Image is not a regular file");
		const chunks: Buffer[] = [];
		let length = 0;
		while (true) {
			signal?.throwIfAborted();
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_LEARNER_IMAGE_BYTES + 1 - length));
			const { bytesRead } = await handle.read(chunk);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > MAX_LEARNER_IMAGE_BYTES) throw new Error("Image exceeds 25 MiB; provide a smaller image");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, length);
	} finally { await handle.close(); }
}

async function normalize(bytes: Uint8Array, signal?: AbortSignal): Promise<ResizedImage> {
	signal?.throwIfAborted();
	const worker = new Worker(path.join(process.cwd(), "src/agent/image-processing/learner-image-worker.mjs"));
	try {
		return await new Promise((resolve, reject) => {
			const abort = () => reject(signal?.reason ?? new Error("Operation aborted"));
			const cleanup = () => signal?.removeEventListener("abort", abort);
			worker.once("message", (message: { result?: ResizedImage; error?: string }) => {
				cleanup();
				if (message.result) resolve(message.result);
				else reject(new Error(message.error ?? "Image normalization failed"));
			});
			worker.once("error", (error) => { cleanup(); reject(error); });
			worker.once("exit", (code) => { cleanup(); reject(new Error(`Image normalization worker exited (${code})`)); });
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else worker.postMessage({ bytes });
		});
	} finally { await worker.terminate(); }
}

export async function loadLearnerImage(rawPath: string, signal?: AbortSignal): Promise<LearnerImage> {
	signal?.throwIfAborted();
	const absolute = await checkLearnerImage(rawPath);
	const bytes = await readBounded(absolute, signal);
	const stored = await processLearnerImageBytes(bytes, signal);
	return { path: absolute, ...stored };
}

/** The shared processing tail (issue #96 uploads ride it too): bound-check
 *  the header, normalize off-thread, and stamp the SHA-256 snapshot
 *  identity. Same bounds and output law as path-based learner images —
 *  PNG/JPEG, ≤1600px per side, under 1 MiB of base64. */
export async function processLearnerImageBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Omit<LearnerImage, "path">> {
	signal?.throwIfAborted();
	if (bytes.byteLength > MAX_LEARNER_IMAGE_BYTES) throw new Error("image exceeds 25 MiB; provide a smaller image");
	const mime = detectSupportedImageMimeType(bytes);
	if (!mime) throw new Error("not a supported image (jpg, png, gif, webp, or bmp)");
	checkImageDimensions(bytes, mime);
	const stored = await normalize(bytes, signal);
	signal?.throwIfAborted();
	if (stored.mimeType !== "image/png" && stored.mimeType !== "image/jpeg") throw new Error("Unexpected stored image format");
	const snapshotId = createHash("sha256").update(Buffer.from(stored.data, "base64")).digest("hex");
	return { snapshotId, mimeType: stored.mimeType, data: stored.data, width: stored.width, height: stored.height };
}

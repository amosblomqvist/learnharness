import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CLIPBOARD_IMAGES_DIR } from "../../config.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/mime.mjs";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "../agent/tools/learner-image-dimensions.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

/** Raw bounded image bytes; never accept a destination path from the browser. */
export async function clipboardImageResponse(request: Request, directory = CLIPBOARD_IMAGES_DIR): Promise<Response> {
	const failure = (error: string, status: number) => Response.json({ error }, { status });
	if (!desktopAPIAuthorized(request.headers) || request.headers.get("x-learnharness-image-paste") !== "1" ||
		request.headers.get("origin") !== subscriptionRequestOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site") {
		return failure("Image paste requires a same-origin LearnHarness request.", 403);
	}
	if (Number(request.headers.get("content-length")) > MAX_LEARNER_IMAGE_BYTES) return failure("Image exceeds 25 MiB.", 413);
	const reader = request.body?.getReader();
	if (!reader) return failure("No image supplied.", 400);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_LEARNER_IMAGE_BYTES) { await reader.cancel(); return failure("Image exceeds 25 MiB.", 413); }
			chunks.push(value);
		}
		const bytes = Buffer.concat(chunks);
		const mime = detectSupportedImageMimeType(bytes);
		const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" } as Record<string, string>)[mime ?? ""];
		if (!mime || !extension) return failure("Paste a PNG, JPEG, GIF, WebP or BMP image.", 415);
		checkImageDimensions(bytes, mime);
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, `pasted-image-${randomUUID()}.${extension}`);
		await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
		return Response.json({ path: file }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return failure(error instanceof Error ? error.message : "Could not save pasted image.", 400);
	} finally { reader.releaseLock(); }
}

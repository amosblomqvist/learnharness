import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import * as photon from "@silvia-odwyer/photon-node";
import {
	detectSupportedImageMimeType,
	detectSupportedImageMimeTypeFromFile,
	processImage,
} from "../src/agent/image-processing/index.ts";
import { applyExifOrientation } from "../src/agent/image-processing/exif-orientation.mjs";
import { resizeImageInProcess } from "../src/agent/image-processing/resize-core.mjs";
import { resizeImage } from "../src/agent/image-processing/resize.ts";

// Synthetic, offline fixtures only. Canvas generates inputs; Photon is the
// actual processing implementation and supplies independent encoding oracles.
function png(width = 96, height = 96, noise = false): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	if (noise) {
		const pixels = context.createImageData(width, height);
		let state = 0x12345678;
		for (let i = 0; i < pixels.data.length; i += 4) {
			for (let channel = 0; channel < 3; channel++) {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
				pixels.data[i + channel] = state >>> 24;
			}
			pixels.data[i + 3] = 255;
		}
		context.putImageData(pixels, 0, 0);
	} else {
		context.fillStyle = "#33aadd";
		context.fillRect(0, 0, width, height);
	}
	return canvas.toBuffer("image/png");
}

function encodings(bytes: Uint8Array, width: number, height: number, qualities = [80, 85, 70, 55, 40]) {
	const image = photon.PhotonImage.new_from_byteslice(bytes);
	const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
	try {
		return [
			{ mimeType: "image/png", data: Buffer.from(resized.get_bytes()).toString("base64") },
			...qualities.map((quality) => ({ mimeType: "image/jpeg", data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64") })),
		];
	} finally {
		resized.free();
		image.free();
	}
}

function bmp(): Buffer {
	// A 2x1, uncompressed, 24-bit Windows BMP (padded scanline).
	const bytes = Buffer.alloc(62);
	bytes.write("BM");
	bytes.writeUInt32LE(bytes.length, 2);
	bytes.writeUInt32LE(54, 10);
	bytes.writeUInt32LE(40, 14);
	bytes.writeInt32LE(2, 18);
	bytes.writeInt32LE(1, 22);
	bytes.writeUInt16LE(1, 26);
	bytes.writeUInt16LE(24, 28);
	bytes.writeUInt32LE(8, 34);
	bytes.set([0, 0, 255, 0, 255, 0], 54);
	return bytes;
}

function exifJpeg(orientation: number): Buffer {
	const image = photon.PhotonImage.new_from_byteslice(png(12, 8));
	let jpeg: Buffer;
	try {
		jpeg = Buffer.from(image.get_bytes_jpeg(80));
	} finally {
		image.free();
	}
	const exif = Buffer.alloc(36);
	exif.set([0xff, 0xe1, 0, 34]);
	exif.write("Exif\0\0", 4, "binary");
	exif.write("II", 10);
	exif.writeUInt16LE(42, 12);
	exif.writeUInt32LE(8, 14);
	exif.writeUInt16LE(1, 18);
	exif.writeUInt16LE(0x0112, 20);
	exif.writeUInt16LE(3, 22);
	exif.writeUInt32LE(1, 24);
	exif.writeUInt16LE(orientation, 28);
	return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

test("already-fit image bytes are unchanged, MIME aliases normalize, and transfer leaves input intact", async () => {
	const bytes = png();
	const original = Buffer.from(bytes);
	const result = await processImage(bytes, " Image/PNG; charset=binary ");
	assert.deepEqual(result, { ok: true, data: bytes.toString("base64"), mimeType: "image/png", hints: [] });
	assert.deepEqual(bytes, original);
	const jpeg = exifJpeg(1);
	assert.deepEqual(await processImage(jpeg, "image/jpg"), { ok: true, data: jpeg.toString("base64"), mimeType: "image/jpeg", hints: [] });
});

test("native default dimensions are 2000x2000 and dimension hints use the native mapping", async () => {
	const bytes = png(12000, 24);
	const result = await processImage(bytes, "image/png");
	assert.ok(result.ok);
	assert.equal(result.mimeType, "image/png");
	assert.deepEqual(result.hints, ["[Image: original 12000x24, displayed at 2000x4. Multiply coordinates by 6.00 to map to original image.]"]);
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
	try {
		assert.equal(decoded.get_width(), 2000);
		assert.equal(decoded.get_height(), 4);
	} finally { decoded.free(); }
	const tall = await resizeImage(png(24, 12000), "image/png");
	assert.ok(tall);
	assert.equal(tall.width, 4);
	assert.equal(tall.height, 2000);
});

test("model dimensions use sequential rounding, not a one-step scale", async () => {
	const result = await resizeImage(png(301, 503), "image/png", { maxWidth: 101, maxHeight: 100 });
	assert.ok(result);
	// 301x503 -> 101x169 -> 60x100.
	assert.equal(result.width, 60);
	assert.equal(result.height, 100);
	assert.equal(result.data, encodings(png(301, 503), 60, 100)[0]!.data);
	const rounding = await resizeImage(png(50, 77), "image/png", { maxWidth: 10, maxHeight: 10 });
	assert.ok(rounding);
	assert.equal(rounding.width, 7); // round(100 / round(77 * 10 / 50)); one-step gives 6.
	assert.equal(rounding.height, 10);
});

test("native cap is strict and measures base64 bytes, not binary bytes", async () => {
	const source = png(24, 24);
	// A valid PNG with ignored trailing bytes: under 4.5 MiB binary, exactly
	// 4.5 MiB base64. At equality the unchanged fast path must NOT run.
	const padded = Buffer.alloc((4.5 * 1024 * 1024 / 4) * 3);
	source.copy(padded);
	assert.ok(padded.length < 4.5 * 1024 * 1024);
	assert.equal(padded.toString("base64").length, 4.5 * 1024 * 1024);
	const exact = await processImage(padded, "image/png");
	assert.ok(exact.ok);
	assert.notEqual(exact.data, padded.toString("base64"));
	assert.ok(exact.data.length < 4.5 * 1024 * 1024);
	assert.equal(exact.hints.length, 1, "native re-encoding is marked resized even at identical dimensions");
	const justBelow = padded.subarray(0, padded.length - 3);
	const below = await processImage(justBelow, "image/png");
	assert.ok(below.ok);
	assert.equal(below.data, justBelow.toString("base64"));
	assert.deepEqual(below.hints, []);
});

test("PNG wins first under cap even when JPEG is smaller", async () => {
	const bytes = png(96, 96, true);
	const candidates = encodings(bytes, 95, 95);
	assert.ok(candidates[0]!.data.length > candidates[1]!.data.length);
	const result = await resizeImage(bytes, "image/png", { maxWidth: 95, maxBytes: candidates[0]!.data.length + 1 });
	assert.ok(result);
	assert.equal(result.mimeType, "image/png");
	assert.equal(result.data, candidates[0]!.data);
});

test("JPEG quality selection is native first-fit [80,85,70,55,40], not smallest output", async () => {
	const bytes = png(96, 96, true);
	const candidates = encodings(bytes, 96, 96);
	assert.ok(candidates[0]!.data.length > candidates[2]!.data.length);
	assert.ok(candidates[2]!.data.length > candidates[1]!.data.length);
	assert.ok(candidates[1]!.data.length > candidates[3]!.data.length);
	const at80 = await resizeImage(bytes, "image/png", { maxBytes: candidates[1]!.data.length + 1 });
	assert.ok(at80);
	assert.equal(at80.data, candidates[1]!.data);
	// Strict equality excludes 80; 85 is larger, so 70 is the next fit.
	const at70 = await resizeImage(bytes, "image/png", { maxBytes: candidates[1]!.data.length });
	assert.ok(at70);
	assert.equal(at70.data, candidates[3]!.data);
	assert.equal(at70.width, 96);
	assert.equal(at70.height, 96);
	for (const [index, quality] of [[4, 55], [5, 40]] as const) {
		const candidate = candidates[index]!;
		const cap = candidate.data.length + 1;
		assert.ok(candidates.slice(0, index).every((earlier) => earlier.data.length >= cap));
		const lowerQuality = await resizeImage(bytes, "image/png", { maxBytes: cap });
		assert.ok(lowerQuality);
		assert.equal(lowerQuality.data, candidate.data, `native quality ${quality} wins when preceding candidates are over cap`);
		assert.equal(lowerQuality.width, 96);
		assert.equal(lowerQuality.height, 96);
	}
	const override = await resizeImage(bytes, "image/png", { jpegQuality: 85, maxBytes: candidates[2]!.data.length + 1 });
	assert.ok(override);
	assert.equal(override.data, candidates[2]!.data, "caller quality precedes the native remaining quality steps");
});

test("all encodings over cap reduce each dimension by floor(0.75), eventually omitting at 1x1", async () => {
	const bytes = png(97, 95, true);
	const full = encodings(bytes, 97, 95);
	const next = encodings(bytes, 72, 71);
	const maxBytes = Math.min(...full.map((candidate) => candidate.data.length));
	const expected = next.find((candidate) => candidate.data.length < maxBytes);
	assert.ok(expected, "synthetic fixture fits on the first reduced dimensions");
	const result = await resizeImage(bytes, "image/png", { maxBytes });
	assert.ok(result);
	assert.equal(result.width, 72);
	assert.equal(result.height, 71);
	assert.equal(result.mimeType, expected.mimeType);
	assert.equal(result.data, expected.data);
	assert.equal(await resizeImage(bytes, "image/png", { maxBytes: 1 }), null);
	const omitted = await processImage(bytes, "image/png", { resizeOptions: { maxBytes: 1 } });
	assert.deepEqual(omitted, { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" });
});

test("BMP converts to PNG and reports the native conversion hint", async () => {
	const bytes = bmp();
	assert.equal(detectSupportedImageMimeType(bytes), "image/bmp");
	const result = await processImage(bytes, "IMAGE/BMP");
	assert.ok(result.ok);
	assert.equal(result.mimeType, "image/png");
	assert.equal(detectSupportedImageMimeType(Buffer.from(result.data, "base64")), "image/png");
	assert.deepEqual(result.hints, ["[Image converted from image/bmp to image/png.]"]);
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
	try {
		assert.equal(decoded.get_width(), 2);
		assert.equal(decoded.get_height(), 1);
	} finally { decoded.free(); }
});

test("EXIF-oriented dimensions govern resizing, with native unchanged-byte behavior when already fit", async () => {
	for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
		const bytes = exifJpeg(orientation);
		const untouched = await resizeImage(bytes, "image/jpeg");
		assert.ok(untouched);
		assert.equal(untouched.data, bytes.toString("base64"));
		assert.equal(untouched.originalWidth, orientation >= 5 ? 8 : 12);
		assert.equal(untouched.originalHeight, orientation >= 5 ? 12 : 8);
		const resized = await resizeImage(bytes, "image/jpeg", { maxWidth: 6, maxHeight: 6 });
		assert.ok(resized);
		assert.equal(resized.width, orientation >= 5 ? 4 : 6);
		assert.equal(resized.height, orientation >= 5 ? 6 : 4);
	}
});

test("EXIF mirrors and rotations preserve exact pixel placement for JPEG and both WebP EXIF layouts", () => {
	const expected = [
		[1, 2, 3, 4, 5, 6], // unchanged
		[3, 2, 1, 6, 5, 4], // horizontal mirror
		[6, 5, 4, 3, 2, 1], // 180 degrees
		[4, 5, 6, 1, 2, 3], // vertical mirror
		[1, 4, 2, 5, 3, 6], // transpose
		[4, 1, 5, 2, 6, 3], // 90 degrees clockwise
		[6, 3, 5, 2, 4, 1], // transverse
		[3, 6, 2, 5, 1, 4], // 90 degrees counterclockwise
	];
	for (let orientation = 1; orientation <= 8; orientation++) {
		const jpeg = exifJpeg(orientation);
		// Only metadata is needed here: decoding is covered by the resize test.
		const exif = jpeg.subarray(6, 38);
		for (const metadata of [jpeg, ...[exif, exif.subarray(6)].map((data) => {
			// Odd-size RIFF chunk before EXIF verifies native even-byte padding.
			const webp = Buffer.alloc(12 + 10 + 8 + data.length);
			webp.write("RIFF", 0);
			webp.writeUInt32LE(webp.length - 8, 4);
			webp.write("WEBP", 8);
			webp.write("JUNK", 12);
			webp.writeUInt32LE(1, 16);
			webp.write("EXIF", 22);
			webp.writeUInt32LE(data.length, 26);
			data.copy(webp, 30);
			return webp;
		})]) {
			const pixels = Uint8Array.from([1, 2, 3, 4, 5, 6].flatMap((value) => [value, 0, 0, 255]));
			const raw = new photon.PhotonImage(pixels, 3, 2);
			const oriented = applyExifOrientation(photon, raw, metadata);
			try {
				assert.equal(oriented.get_width(), orientation >= 5 ? 2 : 3);
				assert.equal(oriented.get_height(), orientation >= 5 ? 3 : 2);
				assert.deepEqual(Array.from(oriented.get_raw_pixels()).filter((_, index) => index % 4 === 0), expected[orientation - 1]);
			} finally {
				if (oriented !== raw) oriented.free();
				raw.free();
			}
		}
	}
});

test("corrupt supported input is omitted, unsupported conversion fails, and explicit autoResizeImages=false retains native bypass", async () => {
	const bytes = Buffer.from("not an image");
	assert.deepEqual(await processImage(bytes, "image/png"), { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" });
	assert.deepEqual(await processImage(bytes, "image/bmp"), { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" });
	assert.deepEqual(await processImage(bytes, "image/png", { autoResizeImages: false }), { ok: true, data: bytes.toString("base64"), mimeType: "image/png", hints: [] });
	const wide = png(12000, 24);
	const bypass = await processImage(wide, "image/png", { autoResizeImages: false });
	assert.ok(bypass.ok);
	assert.equal(bypass.data, wide.toString("base64"));
	const converted = await processImage(bmp(), "image/bmp", { autoResizeImages: false });
	assert.ok(converted.ok);
	assert.equal(converted.mimeType, "image/png");
});

test("MIME sniffing matches native supported signatures and rejects APNG/JPEG-LS/malformed BMP", async () => {
	assert.equal(detectSupportedImageMimeType(png()), "image/png");
	assert.equal(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xf7])), null);
	assert.equal(detectSupportedImageMimeType(Buffer.from("GIF89a")), "image/gif");
	assert.equal(detectSupportedImageMimeType(Buffer.from("GIF87a")), "image/gif");
	assert.equal(detectSupportedImageMimeType(Buffer.from("RIFFxxxxWEBP")), "image/webp");
	assert.equal(detectSupportedImageMimeType(Buffer.from("BM")), null);
	assert.equal(detectSupportedImageMimeType(Buffer.from("not an image")), null);
	const truncatedPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(detectSupportedImageMimeType(truncatedPng), null);
	// MIME sniffing, like Pi, walks chunk headers without checking CRCs.
	const source = png(2, 2);
	const acTL = Buffer.alloc(20);
	acTL.writeUInt32BE(8, 0);
	acTL.write("acTL", 4);
	const apng = Buffer.concat([source.subarray(0, 33), acTL, source.subarray(33)]);
	assert.equal(detectSupportedImageMimeType(apng), null);
	const badBmp = bmp();
	badBmp.writeUInt16LE(2, 26);
	assert.equal(detectSupportedImageMimeType(badBmp), null);
	const dir = await mkdtemp(path.join(os.tmpdir(), "lh-image-processing-"));
	try {
		await writeFile(path.join(dir, "renamed.txt"), source);
		await writeFile(path.join(dir, "animated.png"), apng);
		assert.equal(await detectSupportedImageMimeTypeFromFile(path.join(dir, "renamed.txt")), "image/png");
		assert.equal(await detectSupportedImageMimeTypeFromFile(path.join(dir, "animated.png")), null);
		await assert.rejects(detectSupportedImageMimeTypeFromFile(path.join(dir, "missing")), { code: "ENOENT" });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("unbundled Node worker responds with tagged output and matches the in-process fallback", async () => {
	const bytes = png(96, 96, true);
	const options = { maxWidth: 64, maxHeight: 64, maxBytes: 4000 };
	const worker = new Worker(path.join(process.cwd(), "src/agent/image-processing/resize-worker.mjs"));
	try {
		const reply = new Promise<{ type: string; result: unknown }>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		});
		worker.postMessage({ inputBytes: new Uint8Array(bytes), mimeType: "image/png", options });
		assert.deepEqual(await reply, { type: "pi:image-resize-response", result: await resizeImageInProcess(bytes, "image/png", options) });
		assert.deepEqual(await resizeImage(bytes, "image/png", options), await resizeImageInProcess(bytes, "image/png", options));
	} finally { await worker.terminate(); }
});

test("missing cwd-relative worker falls back in-process without altering the caller bytes", async () => {
	const cwd = process.cwd();
	const dir = await mkdtemp(path.join(os.tmpdir(), "lh-image-worker-fallback-"));
	const bytes = png();
	const options = { maxWidth: 64, maxHeight: 64 };
	const expected = await resizeImageInProcess(bytes, "image/png", options);
	try {
		process.chdir(dir);
		assert.deepEqual(await resizeImage(bytes, "image/png", options), expected);
	} finally {
		process.chdir(cwd);
		await rm(dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectImageBytes } from "../src/core/images.ts";
import { normalizeImage, readBoundedFile, providerSafePng, validateInputImages } from "../src/agent/image-media.ts";
import { ImageInputError, imageBlock, MAX_IMAGE_BYTES } from "../src/core/images.ts";

async function raster(w: number, h: number, fmt: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
	const c = createCanvas(w, h);
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#c33";
	ctx.fillRect(0, 0, w, h);
	return fmt === "png" ? c.encode("png") : fmt === "jpeg" ? c.encode("jpeg", 80) : c.encode("webp", 80);
}
function dims(png: Buffer) {
	return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

describe("normalizeImage", () => {
	it("passes a small PNG through as PNG", async () => {
		const out = await normalizeImage(await raster(40, 30));
		assert.equal(out.type, "image");
		assert.equal(out.mimeType, "image/png");
		assert.deepEqual(dims(Buffer.from(out.data, "base64")), { w: 40, h: 30 });
	});
	it("downscales to 2048 on the longest side", async () => {
		const out = await normalizeImage(await raster(4096, 1024));
		assert.deepEqual(dims(Buffer.from(out.data, "base64")), { w: 2048, h: 512 });
	});
	it("converts JPEG and WebP to PNG by content", async () => {
		for (const f of ["jpeg", "webp"] as const) {
			const out = await normalizeImage(await raster(20, 10, f));
			assert.equal(out.mimeType, "image/png");
		}
	});
	it("converts a BMP to PNG", async () => {
		const bmp = Buffer.alloc(54 + 4 * 4 * 3);
		bmp.write("BM", 0);
		bmp.writeUInt32LE(bmp.length, 2);
		bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(4, 18);
		bmp.writeInt32LE(4, 22);
		bmp.writeUInt16LE(1, 26);
		bmp.writeUInt16LE(24, 28);
		assert.equal(inspectImageBytes(bmp)?.mimeType, "image/bmp");
		const out = await normalizeImage(bmp);
		assert.deepEqual(dims(Buffer.from(out.data, "base64")), { w: 4, h: 4 });
	});
	it("rejects non-images and truncated spoofs", async () => {
		await assert.rejects(normalizeImage(Buffer.from("hello world, not an image at all")), ImageInputError);
		const png = await raster(10, 10);
		await assert.rejects(normalizeImage(png.subarray(0, 30)), ImageInputError);
	});
	it("rejects over-bounds images from the header, before decoding", async () => {
		const png = Buffer.from(await raster(8, 8));
		png.writeUInt32BE(10000, 16);
		png.writeUInt32BE(10000, 20); // 100 MP header
		await assert.rejects(normalizeImage(png), /oversized dimensions/);
		await assert.rejects(normalizeImage(new Uint8Array(21 * 1024 * 1024)), /too large/);
	});
	it("honors an aborted signal", async () => {
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(normalizeImage(await raster(8, 8), ac.signal));
	});
});

/** Insert an EXIF APP1 with Orientation=6 right after SOI. */
function withOrientation6(jpeg: Buffer): Buffer {
	const body = Buffer.concat([
		Buffer.from("Exif\0\0", "binary"),
		Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]),
	]);
	const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, body.length + 2]), body]);
	return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

describe("EXIF-rotated JPEG", () => {
	it("normalizes and validates with the rotated (decoded) geometry", async () => {
		const jpeg = withOrientation6(await raster(32, 16, "jpeg"));
		assert.deepEqual({ w: inspectImageBytes(jpeg)!.width, h: inspectImageBytes(jpeg)!.height }, { w: 32, h: 16 });
		const out = await normalizeImage(jpeg);
		assert.deepEqual(dims(Buffer.from(out.data, "base64")), { w: 16, h: 32 });
		await validateInputImages([imageBlock("image/jpeg", jpeg.toString("base64"))]);
	});
});

describe("validateInputImages", () => {
	it("accepts a real image and leaves bytes alone", async () => {
		const b64 = (await raster(16, 16)).toString("base64");
		const img = imageBlock("image/png", b64);
		await validateInputImages([img]);
		assert.equal(img.data, b64);
	});
	it("rejects declared/actual mismatch", async () => {
		await assert.rejects(validateInputImages([imageBlock("image/jpeg", (await raster(16, 16)).toString("base64"))]), ImageInputError);
	});
	it("rejects a signature-only spoof that does not decode", async () => {
		const real = await raster(16, 16);
		const spoof = Buffer.concat([real.subarray(0, 33), Buffer.alloc(40)]);
		await assert.rejects(validateInputImages([imageBlock("image/png", spoof.toString("base64"))]), ImageInputError);
	});
	it("rejects too many images and oversize payloads", async () => {
		const ok = imageBlock("image/png", (await raster(8, 8)).toString("base64"));
		await assert.rejects(validateInputImages([ok, ok, ok, ok, ok]), ImageInputError);
		const big = Buffer.concat([await raster(8, 8), Buffer.alloc(MAX_IMAGE_BYTES)]);
		await assert.rejects(validateInputImages([imageBlock("image/png", big.toString("base64"))]), ImageInputError);
	});
});

describe("providerSafePng", () => {
	it("is still exported and leaves canonical PNGs alone", async () => {
		const png = await raster(4, 4);
		assert.ok(providerSafePng(png).equals(png));
	});
});

describe("readBoundedFile", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bounded-"));
	it("reads files up to the cap and rejects one byte over, without stat", async () => {
		const f = path.join(dir, "a.bin");
		fs.writeFileSync(f, Buffer.alloc(100, 7));
		assert.equal((await readBoundedFile(f, 100, () => new Error("big"))).length, 100);
		await assert.rejects(readBoundedFile(f, 99, () => new Error("big")), /big/);
	});
	it("a file that grows after any size check still hits the cap", async () => {
		const f = path.join(dir, "grow.bin");
		fs.writeFileSync(f, Buffer.alloc(10));
		const size = fs.statSync(f).size; // the stale "stat" a caller might trust
		fs.appendFileSync(f, Buffer.alloc(3 * 1024 * 1024));
		assert.equal(size, 10);
		await assert.rejects(readBoundedFile(f, 2 * 1024 * 1024, () => new Error("big")), /big/);
	});
	it("honors abort and cleans up", async () => {
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(readBoundedFile(path.join(dir, "a.bin"), 100, () => new Error("big"), ac.signal));
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import {
	IMAGE_ERRORS,
	ImageInputError,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_PIXELS,
	MAX_IMAGES,
	MAX_SOURCE_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	checkImageMeta,
	checkSourceImageMeta,
	imageBlock,
	imageDataUrlMarkdown,
	imageMarker,
	inspectImageBytes,
	parseComposerImages,
} from "../src/core/images.ts";
import { parseChatInput } from "../src/core/input-events.ts";

// ── real fixtures (no image library) ─────────────────────────────────────────
function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}
/** A valid RGB PNG of the given size (solid colour). */
function png(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
	const raw = Buffer.concat(Array.from({ length: Math.min(height, 8) }, () => row));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const JPEG_1x1 = Buffer.from(
	"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
	"base64",
);
const GIF_1x1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const WEBP_1x1 = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

const b64 = (b: Buffer) => b.toString("base64");
const refused = (fn: () => unknown, message?: string) =>
	assert.throws(fn, (e) => e instanceof ImageInputError && (message === undefined || e.message === message));

describe("inspectImageBytes", () => {
	it("reads every supported format from its header", () => {
		assert.deepEqual(inspectImageBytes(png(3, 2)), { mimeType: "image/png", width: 3, height: 2 });
		assert.deepEqual(inspectImageBytes(JPEG_1x1), { mimeType: "image/jpeg", width: 1, height: 1 });
		assert.deepEqual(inspectImageBytes(GIF_1x1), { mimeType: "image/gif", width: 1, height: 1 });
		assert.deepEqual(inspectImageBytes(WEBP_1x1), { mimeType: "image/webp", width: 1, height: 1 });
	});
	it("finds progressive and baseline JPEG frames behind APPn/DQT segments", () => {
		const sof = JPEG_1x1.indexOf(Buffer.from([0xff, 0xc2, 0x00, 0x0b]));
		assert.ok(sof > 0, "fixture is a progressive (SOF2) JPEG");
		assert.deepEqual(inspectImageBytes(JPEG_1x1), { mimeType: "image/jpeg", width: 1, height: 1 });
		const baseline = Buffer.from(JPEG_1x1);
		baseline[sof + 1] = 0xc0;
		assert.deepEqual(inspectImageBytes(baseline), { mimeType: "image/jpeg", width: 1, height: 1 });
		const sized = Buffer.from(baseline);
		sized.writeUInt16BE(300, sof + 5); sized.writeUInt16BE(200, sof + 7);
		assert.deepEqual(inspectImageBytes(sized), { mimeType: "image/jpeg", width: 200, height: 300 });
		assert.equal(inspectImageBytes(JPEG_1x1.subarray(0, sof)), null, "truncated before SOF");
	});
	it("reads BMP (legacy tool read) and rejects zero or truncated headers", () => {
		const bmp = Buffer.alloc(54);
		bmp.write("BM");
		bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(7, 18); bmp.writeInt32LE(-5, 22);
		assert.deepEqual(inspectImageBytes(bmp), { mimeType: "image/bmp", width: 7, height: 5 });
		assert.equal(inspectImageBytes(png(0, 4)), null);
		assert.equal(inspectImageBytes(png(4, 4).subarray(0, 20)), null);
		assert.equal(inspectImageBytes(Buffer.from("not an image at all, just text")), null);
		assert.equal(inspectImageBytes(new Uint8Array(0)), null);
		const noIhdr = Buffer.from(png(2, 2));
		noIhdr.write("IHDX", 12, "ascii");
		assert.equal(inspectImageBytes(noIhdr), null);
	});
});

describe("source vs wire meta", () => {
	it("keeps wire at 5 MiB and source at 20 MiB", () => {
		checkImageMeta("image/png", MAX_IMAGE_BYTES);
		refused(() => checkImageMeta("image/png", MAX_IMAGE_BYTES + 1), IMAGE_ERRORS.size);
		checkSourceImageMeta("image/jpeg", MAX_SOURCE_IMAGE_BYTES);
		refused(() => checkSourceImageMeta("image/jpeg", MAX_SOURCE_IMAGE_BYTES + 1), IMAGE_ERRORS.source);
		refused(() => checkSourceImageMeta("image/bmp", 10), IMAGE_ERRORS.format);
	});
	it("preserves the shared limits", () => {
		assert.deepEqual([MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_SOURCE_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION],
			[4, 5 * 1048576, 10 * 1048576, 20 * 1048576, 25_000_000, 2048]);
	});
});

describe("parseComposerImages", () => {
	it("accepts real images of every user format and keeps the bytes exact", () => {
		const input = [
			imageBlock("image/png", b64(png(4, 4))),
			imageBlock("image/jpeg", b64(JPEG_1x1)),
			imageBlock("image/gif", b64(GIF_1x1)),
			imageBlock("image/webp", b64(WEBP_1x1)),
		];
		const out = parseComposerImages(input);
		assert.deepEqual(out, input);
		assert.deepEqual(parseComposerImages([input[0], input[0]]).map((i) => i.data), [input[0]!.data, input[0]!.data], "duplicates are not deduped");
	});
	it("refuses a header-only fake and a spoofed type", () => {
		const fakePng = Buffer.concat([Buffer.from([137, 80, 78, 71]), Buffer.alloc(40)]);
		refused(() => parseComposerImages([imageBlock("image/png", b64(fakePng))]), IMAGE_ERRORS.content);
		refused(() => parseComposerImages([imageBlock("image/jpeg", b64(png(2, 2)))]), IMAGE_ERRORS.content);
		refused(() => parseComposerImages([imageBlock("image/bmp", b64(png(2, 2)))]), IMAGE_ERRORS.format);
	});
	it("refuses non-canonical base64 without echoing the payload", () => {
		const good = b64(png(2, 2));
		const bad = [good.slice(0, -1), good + "=", good.replace(/.$/, "!"), " " + good, good + "\n", good.slice(0, 20) + "-_" + good.slice(22)];
		for (const data of bad) {
			assert.throws(
				() => parseComposerImages([{ type: "image", mimeType: "image/png", data }]),
				(e) => e instanceof ImageInputError && !e.message.includes(data.slice(0, 12)),
			);
		}
		// non-zero trailing bits (non-canonical): flip the last data char's low bits
		const base = png(2, 2);
		const odd = b64(Buffer.concat([base, Buffer.alloc((4 - (base.length % 3)) % 3)])); // length % 3 === 1 -> "=="
		assert.ok(odd.endsWith("=="));
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const tampered = odd.slice(0, -3) + alphabet[alphabet.indexOf(odd[odd.length - 3]!) | 1] + "==";
		refused(() => parseComposerImages([imageBlock("image/png", tampered)]));
	});
	it("refuses oversized, over-count and over-total payloads before decoding", () => {
		const huge = "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4);
		refused(() => parseComposerImages([imageBlock("image/png", huge)]), IMAGE_ERRORS.size);
		const one = imageBlock("image/png", b64(png(2, 2)));
		refused(() => parseComposerImages(Array(MAX_IMAGES + 1).fill(one)), IMAGE_ERRORS.count);
		const big = "A".repeat(Math.floor((MAX_IMAGE_BYTES * 4) / 3 / 4) * 4);
		refused(() => parseComposerImages([big, big, big].map((d) => imageBlock("image/png", d))), IMAGE_ERRORS.total);
		refused(() => parseComposerImages("nope"), IMAGE_ERRORS.shape);
		refused(() => parseComposerImages([{ type: "text", text: "x" }]), IMAGE_ERRORS.shape);
	});
	it("refuses header bombs and zero dimensions", () => {
		refused(() => parseComposerImages([imageBlock("image/png", b64(png(100_000, 100_000)))]), IMAGE_ERRORS.dimensions);
		refused(() => parseComposerImages([imageBlock("image/png", b64(png(10_000, 10_000)))]), IMAGE_ERRORS.dimensions);
		refused(() => parseComposerImages([imageBlock("image/png", b64(png(0, 10)))]), IMAGE_ERRORS.content);
	});
	it("rides the text event: image-only is allowed, nothing is accepted otherwise", () => {
		const img = imageBlock("image/png", b64(png(2, 2)));
		assert.deepEqual(parseChatInput({ type: "text", text: "", images: [img] }), { type: "text", text: "", images: [img] });
		assert.throws(() => parseChatInput({ type: "text", text: "", images: [] }));
		assert.throws(() => parseChatInput({ type: "text", text: "hi", images: [{ ...img, data: "AAAA" }] }), ImageInputError);
	});
});

describe("text projections", () => {
	it("marks images without bytes and escapes unsafe blocks", () => {
		assert.equal(imageMarker({ mimeType: "image/png" }), "[Image image/png]");
		assert.equal(imageMarker({ mimeType: "x) evil" }), "[Image unknown]");
		assert.equal(imageDataUrlMarkdown({ mimeType: "image/png", data: "QUJD" }, "A [b]"), "![A  b ](data:image/png;base64,QUJD)");
		assert.equal(imageDataUrlMarkdown({ mimeType: "image/png", data: "a b" }), "[Image image/png]");
	});
});

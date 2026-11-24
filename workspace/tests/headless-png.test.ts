import assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { providerSafePng } from "../src/agent/subagents/headless.ts";

/**
 * The 2026-09-19 visual-maker fix (the "image format is illegal" 400s):
 * Chrome writes PNGs with a SPLIT IDAT stream (4KB chunks); Alibaba's vision
 * decoder — behind OpenRouter's qwen3.8-flash, the visual-maker's look-model —
 * rejected those during the 2026-09-18/19 window while every single-IDAT form
 * passed. providerSafePng merges the split back into the canonical ONE-IDAT
 * form (PNG spec: the IDAT chunks are an arbitrary split of ONE zlib stream —
 * the merged form carries the byte-identical stream). Pure Node on purpose:
 * historically the process already carried a native image lib via
 * @huggingface/transformers' nested sharp/libvips, and a second copy (root
 * sharp) triggered macOS's duplicate-libvips ObjC warning — the transformers
 * embedder died with wave 6 (2026-09-23) but the no-native-deps rule lives
 * on: app code carries no image library. These tests pin the property with
 * no native deps at all.
 */

// ── a tiny PNG toolchain (spec-level, no image library) ─────────────────────

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function walkChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
	assert.ok(png.subarray(0, 8).equals(PNG_SIG), "PNG signature");
	const chunks: Array<{ type: string; data: Buffer }> = [];
	let off = 8;
	while (off < png.length) {
		const len = png.readUInt32BE(off);
		const type = png.subarray(off + 4, off + 8).toString("ascii");
		chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	return chunks;
}

/** Build a VALID multi-IDAT PNG — exactly Chrome's shape: one IHDR, the
 *  compressed scanlines split across ≥2 IDAT chunks, one IEND. */
function chromeStyleMultiIdatPng(width = 4, height = 4): Buffer {
	// Raw scanlines: filter byte 0 + width × RGB pixels (white) — the filter
	// byte MUST be 0–4 (libpng rejects anything else).
	const stride = 1 + width * 3;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const row = raw.subarray(y * stride, (y + 1) * stride);
		row[0] = 0; // filter: none
		row.fill(255, 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	const compressed = zlib.deflateSync(raw);
	const split = Math.max(1, Math.floor(compressed.length / 2));
	return Buffer.concat([
		PNG_SIG,
		chunk("IHDR", ihdr),
		chunk("IDAT", compressed.subarray(0, split)),
		chunk("IDAT", compressed.subarray(split)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ─── the tests ───────────────────────────────────────────────────────────────

test("providerSafePng merges a Chrome-style split IDAT stream into ONE chunk, byte-identical stream", async () => {
	const chromeStyle = chromeStyleMultiIdatPng();
	const inChunks = walkChunks(chromeStyle);
	assert.equal(
		inChunks.filter((c) => c.type === "IDAT").length,
		2,
		"fixture sanity: the input is the multi-IDAT shape",
	);

	const fixed = providerSafePng(chromeStyle);
	const outChunks = walkChunks(fixed);
	const outIdats = outChunks.filter((c) => c.type === "IDAT");
	assert.equal(outIdats.length, 1, "exactly one IDAT chunk — the form Alibaba's decoder accepts");
	// The canonical property: the merged chunk's payload is the BYTE-IDENTICAL
	// zlib stream (a transparent re-split, no re-encoding at all).
	assert.ok(
		outIdats[0]!.data.equals(Buffer.concat(inChunks.filter((c) => c.type === "IDAT").map((c) => c.data))),
		"the zlib stream is untouched",
	);
	// Structure preserved: same non-IDAT chunks in order, valid CRCs (walkChunks
	// is dumb, so verify CRC explicitly for the merged chunk).
	assert.deepEqual(
		outChunks.map((c) => c.type),
		["IHDR", "IDAT", "IEND"],
	);
	const fixedBuf = fixed;
	let off = 8;
	while (off < fixedBuf.length) {
		const len = fixedBuf.readUInt32BE(off);
		const crc = fixedBuf.readUInt32BE(off + 8 + len);
		assert.equal(crc, crc32(fixedBuf.subarray(off + 4, off + 8 + len)), `valid CRC on ${fixedBuf.subarray(off + 4, off + 8).toString("ascii")}`);
		off += 12 + len;
	}
	// And it is still a decodable image: the stream inflates to EXACTLY the
	// original scanlines (filter byte 0 + white RGB pixels).
	const stream = walkChunks(fixed).find((c) => c.type === "IDAT")!.data;
	const stride = 1 + 4 * 3;
	const expected = Buffer.alloc(stride * 4);
	for (let y = 0; y < 4; y++) {
		const row = expected.subarray(y * stride, (y + 1) * stride);
		row[0] = 0;
		row.fill(255, 1);
	}
	assert.ok(zlib.inflateSync(stream).equals(expected), "inflates to the original raw scanlines");
});

test("a single-IDAT PNG is already canonical: returned byte-identical (no-op)", () => {
	// One-IDAT input → one IDAT out, same bytes — the normal case (e.g. the
	// doctrine-gate re-render of an already-canonical PNG).
	const stride = 1 + 4 * 3;
	const raw = Buffer.alloc(stride * 4);
	for (let y = 0; y < 4; y++) {
		const row = raw.subarray(y * stride, (y + 1) * stride);
		row[0] = 0;
		row.fill(200, 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(4, 0);
	ihdr.writeUInt32BE(4, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const single = Buffer.concat([
		PNG_SIG,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	assert.ok(providerSafePng(single).equals(single), "byte-identical — canonical input is untouched");
});

test("non-PNG or truncated input passes through unchanged (defensive)", () => {
	const notPng = Buffer.from("definitely not a png");
	assert.ok(providerSafePng(notPng).equals(notPng));
	const truncated = chromeStyleMultiIdatPng().subarray(0, 20);
	assert.ok(providerSafePng(truncated).equals(truncated));
});
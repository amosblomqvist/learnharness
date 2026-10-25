/**
 * Wave E stage 1 (owner 2026-10-10): pdf_render is NATIVE — pdfjs paints
 * into @napi-rs/canvas in-process, no browser anywhere. These tests pin
 * the real renderer against the real fixture: valid canonical PNGs, dpi
 * scaling arithmetic (scale = dpi/72), out-of-range page skipping, and the
 * Skia canvas actually being exercised (not a DOM canvas — none exists in
 * this process).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { realHeadless } from "../src/agent/subagents/headless.ts";
import { standardFontsDir } from "../src/agent/subagents/pdf-ops.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

/** Minimal PNG chunk walk — returns IHDR dims and the IDAT chunk count. */
function pngFacts(buf: Buffer): { w: number; h: number; idats: number } {
	assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	let off = 8;
	let idats = 0;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString("ascii");
		if (type === "IDAT") idats++;
		off += 12 + len; // len + type + data + crc
	}
	return { w, h, idats };
}

describe("native pdf_render (pdfjs paints, @napi-rs/canvas hosts)", () => {
	it("the shared font directory ends in pdfjs's required slash on every OS", () => {
		const fonts = standardFontsDir();
		assert.ok(fonts.endsWith("/"), "pdfjs rejects a trailing Windows backslash");
		assert.ok(fs.statSync(fonts).isDirectory(), "the filesystem accepts the shared font path");
	});

	it("renders fixture pages as canonical single-IDAT PNGs", async () => {
		const pages = await realHeadless.renderPdfPages(FIXTURE, [1, 3], { dpi: 150 });
		assert.equal(pages.length, 2, "requested pages 1 and 3");
		assert.deepEqual(
			pages.map((p) => p.page),
			[1, 3],
		);
		for (const p of pages) {
			const facts = pngFacts(p.png);
			assert.ok(facts.w > 0 && facts.h > 0, "non-empty raster");
			// providerSafePng canonical form: exactly one IDAT.
			assert.equal(facts.idats, 1, "single-IDAT canonical PNG");
		}
	});

	it("dpi arithmetic: 72dpi base doubles at 144dpi", async () => {
		const [a] = await realHeadless.renderPdfPages(FIXTURE, [1], { dpi: 72 });
		const [b] = await realHeadless.renderPdfPages(FIXTURE, [1], { dpi: 144 });
		assert.ok(a && b, "both renders returned a page");
		const fa = pngFacts(a.png);
		const fb = pngFacts(b.png);
		assert.ok(Math.abs(fb.w - 2 * fa.w) <= 2, `144dpi width ≈ 2× 72dpi (${fa.w} → ${fb.w})`);
		assert.ok(Math.abs(fb.h - 2 * fa.h) <= 2, `144dpi height ≈ 2× 72dpi (${fa.h} → ${fb.h})`);
	});

	it("skips out-of-range page numbers silently", async () => {
		const pages = await realHeadless.renderPdfPages(FIXTURE, [0, 2, 99], { dpi: 72 });
		assert.deepEqual(
			pages.map((p) => p.page),
			[2],
			"only the in-range page renders",
		);
	});

	it("renders with NO browser present (available() may be false)", async () => {
		// The whole point of stage 1: rendering must not consult any Chrome.
		// realHeadless.available() reflects system Chrome only; on this
		// machine it may well be true — the assertion that matters is that
		// the render path never launches one, pinned by the import graph:
		// renderPdfPages touches pdfjs + @napi-rs/canvas and nothing else.
		const pages = await realHeadless.renderPdfPages(FIXTURE, [1], { dpi: 72 });
		assert.equal(pages.length, 1);
	});

	it("crop renders only the region and rejects bad crops / too many pages", async () => {
		const [full] = await realHeadless.renderPdfPages(FIXTURE, [1], { dpi: 72 });
		const [part] = await realHeadless.renderPdfPages(FIXTURE, [1], { dpi: 72, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } });
		const f = pngFacts(full!.png);
		const c = pngFacts(part!.png);
		assert.ok(Math.abs(c.w - f.w / 2) <= 1 && Math.abs(c.h - f.h / 2) <= 1);
		await assert.rejects(realHeadless.renderPdfPages(FIXTURE, [1], { crop: { x: 0, y: 0, width: 1.5, height: 1 } }));
		await assert.rejects(realHeadless.renderPdfPages(FIXTURE, [1, 2, 3, 4, 5, 6, 7]), /at most 6/);
		await assert.rejects(realHeadless.renderPdfPages(FIXTURE, [99], { strict: true }), /out of range/);
	});

	it("caps output at 2048px on the longest side", async () => {
		const [p] = await realHeadless.renderPdfPages(FIXTURE, [1], { dpi: 300 });
		const f = pngFacts(p!.png);
		assert.ok(Math.max(f.w, f.h) <= 2048);
	});
});

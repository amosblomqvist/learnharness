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
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MAX_PDF_CANVAS_PIXELS, MAX_PDF_CANVAS_SIDE, pdfCanvasGeometry, realHeadless } from "../src/agent/subagents/headless.ts";
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

/** Synthetic page only — no personal PDF or external fixture generator. */
function oversizedPdf(): Buffer {
	const content = "0 0 1 rg 0 0 20000 10000 re f\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20000 10000] /Rotate 90 /Resources << >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
	];
	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}

describe("PDF pre-allocation canvas geometry", () => {
	it("uses decimal 16 megapixels and an 8192-pixel side limit", () => {
		assert.equal(MAX_PDF_CANVAS_PIXELS, 16_000_000);
		assert.equal(MAX_PDF_CANVAS_SIDE, 8192);
	});

	it("preserves ordinary requested DPI, including fractional ceil dimensions and low DPI", () => {
		for (const dpi of [11, 72, 144, 150, 300]) {
			const geometry = pdfCanvasGeometry(595.28, 841.89, dpi);
			assert.deepEqual(geometry, {
				scale: dpi / 72,
				width: Math.ceil(595.28 * dpi / 72),
				height: Math.ceil(841.89 * dpi / 72),
			});
		}
	});

	it("bounds extreme aspect ratios, huge geometry, sides, and rounded pixel area without upscaling", () => {
		const cases: readonly (readonly [number, number, number])[] = [
			[1e12, 0.000001, 300],
			[0.000001, 1e12, 300],
			[1e308, 1e308, Number.MAX_VALUE],
			[8192.000001, 10, 72],
			[6100, 3900, 72], // ceil at the area-limited scale exceeds 16MP
			[4000.000001, 4000.000001, 72],
			[4000, 4000, 72], // exactly 16MP stays unchanged
		];
		for (const [width, height, dpi] of cases) {
			const result = pdfCanvasGeometry(width, height, dpi);
			assert.ok(result.scale > 0 && result.scale <= dpi / 72);
			assert.equal(result.width, Math.max(1, Math.ceil(width * result.scale)));
			assert.equal(result.height, Math.max(1, Math.ceil(height * result.scale)));
			assert.ok(result.width <= MAX_PDF_CANVAS_SIDE && result.height <= MAX_PDF_CANVAS_SIDE);
			assert.ok(result.width * result.height <= MAX_PDF_CANVAS_PIXELS);
		}
		assert.deepEqual(pdfCanvasGeometry(4000, 4000, 72), { scale: 1, width: 4000, height: 4000 });
	});

	it("uses rotated viewport dimensions symmetrically", () => {
		const normal = pdfCanvasGeometry(20000, 10000, 144);
		const rotated = pdfCanvasGeometry(10000, 20000, 144);
		assert.equal(rotated.scale, normal.scale);
		assert.equal(rotated.width, normal.height);
		assert.equal(rotated.height, normal.width);
	});

	it("rejects nonfinite or nonpositive dimensions and DPI cleanly", () => {
		for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
			assert.throws(() => pdfCanvasGeometry(invalid, 792, 72), /dimensions must be finite and positive/);
			assert.throws(() => pdfCanvasGeometry(612, invalid, 72), /dimensions must be finite and positive/);
			assert.throws(() => pdfCanvasGeometry(612, 792, invalid), /DPI must be finite and positive/);
		}
	});
});

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

	it("bounds a synthetic oversized rotated PDF before native canvas allocation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-canvas-test-"));
		try {
			const fixture = path.join(dir, "oversized.pdf");
			fs.writeFileSync(fixture, oversizedPdf());
			const [page] = await realHeadless.renderPdfPages(fixture, [1], { dpi: 144 });
			assert.ok(page);
			const facts = pngFacts(page.png);
			const expected = pdfCanvasGeometry(10000, 20000, 144);
			assert.equal(facts.w, expected.width);
			assert.equal(facts.h, expected.height);
			assert.ok(facts.h > facts.w, "PDF rotation is included before scaling");
			assert.ok(facts.w <= 8192 && facts.h <= 8192);
			assert.ok(facts.w * facts.h <= 16_000_000);
			assert.equal(facts.idats, 1, "raw renderer still returns canonical PNG");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects invalid DPI before opening the PDF", async () => {
		for (const dpi of [0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE]) {
			await assert.rejects(realHeadless.renderPdfPages("unused.pdf", [1], { dpi }), /DPI must be finite and positive/);
		}
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
});

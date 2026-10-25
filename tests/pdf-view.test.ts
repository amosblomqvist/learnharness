import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pdfViewTool } from "../src/agent/tools/pdf-view.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const run = (args: Record<string, unknown>, signal?: AbortSignal) => pdfViewTool.execute!("t", args as never, signal);
const dims = (b64: string) => {
	const b = Buffer.from(b64, "base64");
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

describe("pdf_view", () => {
	it("returns a native text + image result with source/page details and no pixels in details", async () => {
		const r = await run({ path: FIXTURE, page: 2, dpi: 72 });
		assert.equal(r.content[0]!.type, "text");
		const img = r.content[1] as { type: string; data: string; mimeType: string };
		assert.equal(img.type, "image");
		assert.equal(img.mimeType, "image/png");
		const d = r.details as { text: string; source: string; page: number; crop?: unknown };
		assert.equal(d.source, FIXTURE);
		assert.equal(d.page, 2);
		assert.equal(d.crop, undefined);
		assert.ok(!JSON.stringify(d).includes(img.data.slice(0, 40)), "no image copy in details");
	});
	it("crops: output dims follow the crop and the crop is recorded", async () => {
		const full = dims(((await run({ path: FIXTURE, page: 1, dpi: 144 })).content[1] as { data: string }).data);
		const r = await run({ path: FIXTURE, page: 1, dpi: 144, crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } });
		const d = dims((r.content[1] as { data: string }).data);
		assert.ok(Math.abs(d.w - full.w / 2) <= 2, `${d.w} vs ${full.w / 2}`);
		assert.ok(Math.abs(d.h - full.h / 4) <= 2, `${d.h} vs ${full.h / 4}`);
		assert.deepEqual((r.details as { crop: unknown }).crop, { x: 0.25, y: 0.5, width: 0.5, height: 0.25 });
	});
	it("rejects invalid crops", async () => {
		const bad = [
			{ x: -0.1, y: 0, width: 0.5, height: 0.5 },
			{ x: 0, y: 0, width: 0, height: 0.5 },
			{ x: 0.6, y: 0, width: 0.6, height: 0.5 },
			{ x: 0, y: 0.9, width: 0.5, height: 0.2 },
			{ x: Number.NaN, y: 0, width: 0.5, height: 0.5 },
		];
		for (const crop of bad) await assert.rejects(run({ path: FIXTURE, page: 1, crop }), /crop/, JSON.stringify(crop));
	});
	it("rejects out-of-range pages and dpi, missing and non-PDF files", async () => {
		await assert.rejects(run({ path: FIXTURE, page: 4 }), /out of range/);
		await assert.rejects(run({ path: FIXTURE, page: 1, dpi: 500 }));
		await assert.rejects(run({ path: path.join(os.tmpdir(), "nope-lh.pdf"), page: 1 }));
		const txt = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		await assert.rejects(run({ path: txt, page: 1 }));
	});
	it("rejects PDFs over 100 MiB without reading them", async () => {
		const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdfview-")), "big.pdf");
		const fd = fs.openSync(f, "w");
		fs.ftruncateSync(fd, 101 * 1024 * 1024); // sparse
		fs.closeSync(fd);
		try {
			await assert.rejects(run({ path: f, page: 1 }), /too large/);
		} finally {
			fs.rmSync(path.dirname(f), { recursive: true, force: true });
		}
	});
});

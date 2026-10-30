/**
 * pdf-ops (sources v0) — the pdfjs text layer against a committed fixture
 * (tests/fixtures/sample-3page.pdf: 3 pages, distinct subjects, "force" on
 * page 2 only; tests/fixtures/sample-multiline.pdf: 1 page, 3 text lines,
 * "keyword" on line 2 only). The render path (headless Chrome) is covered
 * by the pdf-reader loop tests via the headlessOverride fake.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parsePageSpec, pdfExtract, pdfInfo, pdfProbe, pdfSearch } from "../src/agent/subagents/pdf-ops.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const MULTILINE = path.join(import.meta.dirname, "fixtures", "sample-multiline.pdf");

describe("pdf-ops — the pdfjs text layer", () => {
	it("pdfInfo triages every page (count, text lengths, image counts, math density)", async () => {
		const info = await pdfInfo(FIXTURE);
		assert.equal(info.page_count, 3);
		assert.equal(info.pages.length, 3);
		assert.equal(info.pages[0]!.page, 1);
		assert.ok(info.pages.every((p) => p.text_length > 0));
		assert.ok(info.mean_text_length > 0);
		// fixture has no images
		assert.ok(info.pages.every((p) => p.image_count === 0));
	});

	it("pdfExtract heads pages and honors the spec", async () => {
		const two = await pdfExtract(FIXTURE, "1-2");
		assert.match(two, /^--- Page 1 ---/);
		assert.match(two, /--- Page 2 ---/);
		assert.ok(!two.includes("--- Page 3 ---"), "page 3 not requested");
		assert.match(two, /Calculus/);
		const picks = await pdfExtract(FIXTURE, "1,3");
		assert.match(picks, /--- Page 1 ---/);
		assert.ok(!picks.includes("--- Page 2 ---"));
		assert.match(picks, /Chemistry/);
	});

	it("pdfSearch finds hits with page/line + context, literal and regex", async () => {
		const lit = await pdfSearch(FIXTURE, "force", { literal: true });
		assert.equal(lit.hits.length, 1);
		assert.equal(lit.hits[0]!.page, 2);
		assert.match(lit.hits[0]!.context, />>> /);
		// regex with case-insensitivity
		const re = await pdfSearch(FIXTURE, "H2O|water");
		assert.equal(re.hits.length, 1);
		assert.equal(re.hits[0]!.page, 3);
		// no-hit silence
		const none = await pdfSearch(FIXTURE, "zymurgy", { literal: true });
		assert.equal(none.hits.length, 0);
		// invalid regex throws the skill's error shape
		await assert.rejects(() => pdfSearch(FIXTURE, "([unclosed"), /Invalid regex/);
	});

	it("pdfExtract keeps each text line on its own line", async () => {
		const text = await pdfExtract(MULTILINE, "1");
		assert.equal(
			text,
			"--- Page 1 ---\nFirst line of the page\nSecond line with a keyword\nThird line ends here",
		);
	});

	it("pdfSearch reports the hit's own line with its neighbours as context", async () => {
		const { hits } = await pdfSearch(MULTILINE, "keyword", { literal: true, contextLines: 1 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.line, 2);
		assert.equal(
			hits[0]!.context,
			"    First line of the page\n>>> Second line with a keyword\n    Third line ends here",
		);
	});

	it("pdfProbe accepts the fixture and rejects garbage", async () => {
		await pdfProbe(FIXTURE); // resolves
		const garbage = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		await assert.rejects(() => pdfProbe(garbage));
	});

	it("parsePageSpec: all / ranges / lists / clamping", () => {
		assert.deepEqual(parsePageSpec("all", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("1-5", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("1,3,7", 3), [1, 3]);
		assert.deepEqual(parsePageSpec("3", 3), [3]);
		assert.deepEqual(parsePageSpec(" 2 , 1 ", 3), [1, 2]);
	});
});
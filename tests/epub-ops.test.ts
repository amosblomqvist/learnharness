/**
 * epub-ops — the EPUB reading layer behind the epub_* tools: structure
 * (title, author, chapters from the TOC), one chapter as Markdown, and
 * chapter-labeled search. EPUBs are built in memory (fixtures/make-epub.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { EpubError, epubChapterMarkdown, epubInfo, epubSearch } from "../src/agent/subagents/epub-ops.ts";
import { makeEpub } from "./fixtures/make-epub.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-epub-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Uint8Array): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, bytes);
	return p;
}

const book = write(
	"book.epub",
	makeEpub({
		title: "Mechanics Primer",
		author: "Ada Newton",
		chapters: [
			{ title: "Cover", body: `<p>Mechanics Primer</p>` },
			{ title: "Kinematics", body: `<h1>Kinematics</h1><p>Velocity is the rate of change of position.</p>` },
			{
				title: "Forces",
				body:
					`<h1>Forces</h1><h2>Newton's second law</h2>` +
					Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1} about <em>force</em> and mass.</p>`).join(""),
			},
		],
	}),
);

describe("epub-ops", () => {
	it("lists title, author and the chapters in reading order with their TOC titles", async () => {
		const info = await epubInfo(book);
		assert.equal(info.title, "Mechanics Primer");
		assert.equal(info.author, "Ada Newton");
		assert.deepEqual(info.chapters.map((c) => [c.chapter, c.title]), [
			[1, "Cover"],
			[2, "Kinematics"],
			[3, "Forces"],
		]);
		assert.ok(info.chapters[2]!.words > info.chapters[1]!.words, "word counts reflect chapter length");
	});

	it("reads EPUB 2 books through the NCX table of contents", async () => {
		const p = write("ncx.epub", makeEpub({ ncx: true, chapters: [{ title: "Only", body: "<p>x</p>" }] }));
		assert.deepEqual((await epubInfo(p)).chapters.map((c) => c.title), ["Only"]);
	});

	it("returns one chapter as Markdown, without markup from other chapters", async () => {
		const md = await epubChapterMarkdown(book, 3);
		assert.match(md, /^# Forces/m);
		assert.match(md, /^## Newton's second law/m);
		assert.match(md, /Paragraph 40 about _force_ and mass\./);
		assert.doesNotMatch(md, /Velocity/);
		assert.doesNotMatch(md, /p\{\}/, "styles are not content");
	});

	it("finds matches labeled with chapter and nearest heading", async () => {
		const hits = await epubSearch(book, "velocity");
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.chapter, 2);
		assert.equal(hits[0]!.chapterTitle, "Kinematics");
		assert.equal(hits[0]!.heading, "Kinematics");
		assert.match(hits[0]!.text, /rate of change of position/);
	});

	it("caps search hits", async () => {
		assert.equal((await epubSearch(book, "force", { maxHits: 5 })).length, 5);
	});

	it("refuses an out-of-range chapter with the valid range", async () => {
		await assert.rejects(epubChapterMarkdown(book, 9), (e: unknown) => e instanceof EpubError && /1-3/.test(e.message));
	});

	it("refuses DRM-encrypted books with a readable reason", async () => {
		const p = write("drm.epub", makeEpub({ encrypted: true, chapters: [{ title: "A", body: "<p>x</p>" }] }));
		await assert.rejects(epubInfo(p), (e: unknown) => e instanceof EpubError && /DRM/.test(e.message));
	});

	it("refuses files that are not EPUBs", async () => {
		const p = write("not.epub", new TextEncoder().encode("hello"));
		await assert.rejects(epubInfo(p), (e: unknown) => e instanceof EpubError);
	});
});

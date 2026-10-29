/**
 * COURSE LIBRARY — import pipeline pins (course library wave, 2026-10-29):
 * the in-app OOXML extraction (slides, notes, titles, sections, tables,
 * math text, embedded pictures), and the server's upload → processing →
 * deletion choreography under an isolated LH_DATA_DIR. LibreOffice is
 * pinned OFF (sofficeOverride) so the suite is deterministic everywhere.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { buildDocx, buildPptx, TINY_PNG } from "./helpers/ooxml.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-import-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { extractOffice, readEmbeddedImage, embeddedImageMime } = await import("../src/agent/library/office-extract.ts");
const { sofficeOverride } = await import("../src/agent/library/libreoffice.ts");
const server = await import("../src/server/library.ts");
const { stores } = await import("../src/server/stores.ts");
sofficeOverride.current = null;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PDF_FIXTURE = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf")));

describe("office extraction (in-app fallback)", () => {
	it("PPTX: slides in presentation order with titles, body, notes, and pictures", () => {
		const pptx = buildPptx([
			{ title: "Limits", body: ["ε-δ definition", "One-sided limits &amp; continuity"], notes: "Stress the quantifier order.", image: true },
			{ title: "Derivatives", body: ["Power rule"] },
		]);
		const doc = extractOffice(pptx, "pptx");
		assert.equal(doc.unitLabel, "slide");
		assert.equal(doc.units.length, 2);
		const [s1, s2] = doc.units;
		assert.equal(s1!.index, 1);
		assert.equal(s1!.title, "Limits");
		assert.match(s1!.text, /ε-δ definition/);
		assert.match(s1!.text, /One-sided limits & continuity/);
		assert.equal(s1!.notes, "Stress the quantifier order.");
		assert.deepEqual(s1!.images, ["ppt/media/image1.png"]);
		assert.equal(s2!.title, "Derivatives");
		assert.equal(s2!.notes, undefined);
		assert.deepEqual(new Uint8Array(readEmbeddedImage(pptx, "ppt/media/image1.png")!), TINY_PNG);
		assert.equal(embeddedImageMime("ppt/media/image1.png"), "image/png");
		assert.equal(embeddedImageMime("ppt/media/image9.emf"), null);
	});

	it("DOCX: heading-split sections, tables, math text, pictures in place", () => {
		const docx = buildDocx([
			{ para: "Preamble text." },
			{ heading: "Unit 1: Limits" },
			{ para: "A limit describes behavior near a point." },
			{ table: [["x", "f(x)"], ["1", "2"]] },
			{ image: true },
			{ heading: "Unit 2: Derivatives" },
			{ math: "f′(x)=2x" },
		]);
		const doc = extractOffice(docx, "docx");
		assert.equal(doc.unitLabel, "section");
		assert.deepEqual(doc.units.map((u) => u.title), [undefined, "Unit 1: Limits", "Unit 2: Derivatives"]);
		assert.equal(doc.units[0]!.text, "Preamble text.");
		assert.match(doc.units[1]!.text, /x \| f\(x\)\n1 \| 2/);
		assert.deepEqual(doc.units[1]!.images, ["word/media/image1.png"]);
		assert.match(doc.units[2]!.text, /f′\(x\)=2x/);
		assert.deepEqual(doc.units.map((u) => u.index), [1, 2, 3]);
	});

	it("Office Math delimiters: default parens, custom brackets, empty pairs", () => {
		const t = (x: string) => `<m:r><m:t>${x}</m:t></m:r>`;
		const doc = extractOffice(
			buildDocx([
				{ omml: `${t("f")}<m:d><m:e>${t("x")}</m:e></m:d>` },
				{ omml: `<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${t("a,b")}</m:e></m:d>` },
				{ omml: `${t("g")}<m:d></m:d>` },
			]),
			"docx",
		);
		assert.equal(doc.units[0]!.text, "f(x)\n[a,b]\ng()");
	});

	it("DOCX: long heading-less stretches split into bounded sections", () => {
		const para = "x".repeat(1500);
		const doc = extractOffice(buildDocx(Array.from({ length: 6 }, () => ({ para }))), "docx");
		assert.ok(doc.units.length >= 3);
		for (const unit of doc.units) assert.ok(unit.text.length <= 4000 + 1500);
	});

	it("throws a readable error on non-OOXML bytes", () => {
		assert.throws(() => extractOffice(new TextEncoder().encode("not a zip"), "docx"), /Not a readable DOCX/);
		assert.throws(() => extractOffice(buildDocx([{ para: "x" }]), "pptx"), /no presentation part/);
	});
});

describe("upload → processing → deletion", () => {
	const lib = () => stores.libraryStore;

	it("rejects bad uploads without writing anything", () => {
		const before = lib().listItems().length;
		const result = server.uploadLibraryFile(null, "old.ppt", new Uint8Array([1]));
		assert.equal(result.ok, false);
		assert.equal(lib().listItems().length, before);
	});

	it("PDF → ready via pdf with page count", async () => {
		const up = server.uploadLibraryFile(null, "lecture.pdf", PDF_FIXTURE);
		assert.ok(up.ok);
		await server.processLibraryFile(up.item.id);
		const item = lib().getItem(up.item.id)!;
		assert.equal(item.file?.status, "ready");
		assert.equal(item.file?.via, "pdf");
		assert.equal(item.file?.pages, 3);
	});

	it("a PDF that isn't one fails with a reason and stays listed", async () => {
		const up = server.uploadLibraryFile(null, "fake.pdf", new TextEncoder().encode("hello"));
		assert.ok(up.ok);
		await server.processLibraryFile(up.item.id);
		const item = lib().getItem(up.item.id)!;
		assert.equal(item.file?.status, "failed");
		assert.ok(item.file?.error);
	});

	it("image content is sniffed, not trusted by extension", async () => {
		const good = server.uploadLibraryFile(null, "board.png", TINY_PNG);
		const bad = server.uploadLibraryFile(null, "board.jpg", new TextEncoder().encode("nope"));
		assert.ok(good.ok && bad.ok);
		await server.processLibraryFile(good.item.id);
		await server.processLibraryFile(bad.item.id);
		assert.equal(lib().getItem(good.item.id)!.file?.via, "image");
		assert.equal(lib().getItem(bad.item.id)!.file?.status, "failed");
	});

	it("PPTX without LibreOffice → extracted.json with slide count", async () => {
		const up = server.uploadLibraryFile(null, "deck.pptx", buildPptx([{ title: "A", body: ["a"] }, { title: "B", body: ["b"] }]));
		assert.ok(up.ok);
		await server.processLibraryFile(up.item.id);
		const item = lib().getItem(up.item.id)!;
		assert.equal(item.file?.via, "extracted");
		assert.equal(item.file?.pages, 2);
		assert.equal(server.readExtracted(up.item.id)?.units[1]?.title, "B");
	});

	it("deletion lists direct and folder-level users, detaches only direct references", () => {
		const course = lib().createFolder(null, "Math 3339");
		const unit = lib().createFolder(course.id, "Unit 1");
		const up = server.uploadLibraryFile(unit.id, "quiz.pdf", PDF_FIXTURE);
		assert.ok(up.ok);
		const direct = stores.chatStore.createChat("Direct");
		const viaFolder = stores.chatStore.createChat("Via course");
		const other = stores.chatStore.createChat("Other");
		assert.ok(server.setChatAttachments(direct.id, [unit.id, "dup", unit.id].filter((x) => x !== "dup")).ok);
		assert.ok(server.setChatAttachments(viaFolder.id, [course.id]).ok);
		assert.deepEqual(server.chatAttachmentFiles(viaFolder.id).map((f) => f.id), [up.item.id]);

		const impact = server.libraryDeletionImpact(unit.id)!;
		assert.deepEqual(new Set(impact.itemIds), new Set([unit.id, up.item.id]));
		assert.deepEqual(new Set(impact.chats.map((c) => c.title)), new Set(["Direct", "Via course"]));

		server.deleteLibraryItem(unit.id);
		assert.equal(stores.chatStore.getChat(direct.id)?.attachments, undefined);
		assert.deepEqual(stores.chatStore.getChat(viaFolder.id)?.attachments, [course.id]);
		assert.equal(stores.chatStore.getChat(other.id)?.attachments, undefined);
		assert.equal(server.libraryDeletionImpact(unit.id), null);
	});

	it("setChatAttachments refuses unknown ids and dedupes", () => {
		const folder = lib().createFolder(null, "Dedupe");
		const chat = stores.chatStore.createChat("Dedupe");
		assert.equal(server.setChatAttachments(chat.id, ["fld_missing"]).ok, false);
		const ok = server.setChatAttachments(chat.id, [folder.id, folder.id]);
		assert.deepEqual(ok.ok && ok.attachments, [folder.id]);
	});
});

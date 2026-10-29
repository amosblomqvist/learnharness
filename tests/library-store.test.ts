/**
 * COURSE LIBRARY — contracts + store pins (course library wave,
 * 2026-10-29). The pure tree folds (tag inheritance, attachment
 * resolution, move gate, upload gate) and the fs adapter's integrity
 * rules + events, under an isolated LH_DATA_DIR (the seam is set before
 * any config-loading import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { libraryStore } = await import("../src/store/library.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const lib = await import("../src/core/contracts/library.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PDF = { ext: "pdf", mime: "application/pdf", format: "pdf" as const };

describe("library contracts (pure)", () => {
	it("classifyUpload accepts modern formats and rejects legacy/HEIC/oversize with specific messages", () => {
		assert.deepEqual(lib.classifyUpload("Lecture 1.PDF", 10), { ok: true, ext: "pdf", ...lib.LIBRARY_FORMATS.pdf });
		assert.equal(lib.classifyUpload("deck.pptx", 10).ok, true);
		assert.equal(lib.classifyUpload("photo.jpeg", 10).ok, true);
		const doc = lib.classifyUpload("old.doc", 10);
		assert.equal(doc.ok, false);
		assert.match(doc.ok ? "" : doc.error, /\.docx/);
		const heic = lib.classifyUpload("IMG_1.HEIC", 10);
		assert.match(heic.ok ? "" : heic.error, /HEIC/);
		assert.match((lib.classifyUpload("notes.txt", 10) as { error: string }).error, /Unsupported file type \.txt/);
		assert.match((lib.classifyUpload("big.pdf", lib.LIBRARY_MAX_FILE_BYTES + 1) as { error: string }).error, /100 MB/);
		assert.match((lib.classifyUpload("empty.pdf", 0) as { error: string }).error, /empty/);
	});

	it("validateLibraryName trims and rejects separators/empties", () => {
		assert.deepEqual(lib.validateLibraryName("  Unit 1 "), { ok: true, name: "Unit 1" });
		assert.equal(lib.validateLibraryName("a/b").ok, false);
		assert.equal(lib.validateLibraryName("   ").ok, false);
		assert.equal(lib.validateLibraryName(7).ok, false);
	});

	const now = "2026-10-29T00:00:00.000Z";
	const folder = (id: string, parentId: string | null, name: string, tag?: import("../src/core/contracts/library.ts").LibraryTag) =>
		({ id, parentId, kind: "folder" as const, name, createdAt: now, updatedAt: now, ...(tag ? { tag } : {}) });
	const file = (id: string, parentId: string | null, name: string, tag?: import("../src/core/contracts/library.ts").LibraryTag) =>
		({ ...folder(id, parentId, name, tag), kind: "file" as const });
	const items = [
		folder("course", null, "Math 3339"),
		folder("u1", "course", "Unit 1"),
		folder("quizzes", "u1", "Quizzes", "quiz"),
		file("q1", "quizzes", "quiz1.pdf"),
		file("q1key", "quizzes", "quiz1-key.pdf", "answer-key"),
		folder("lectures", "u1", "Lectures", "lecture"),
		file("l1", "lectures", "lecture1.pptx"),
		file("syll", "course", "syllabus.pdf", "syllabus"),
	];

	it("effectiveTag: own tag wins, else nearest tagged ancestor, else none", () => {
		assert.equal(lib.effectiveTag(items, "q1"), "quiz");
		assert.equal(lib.effectiveTag(items, "q1key"), "answer-key");
		assert.equal(lib.effectiveTag(items, "l1"), "lecture");
		assert.equal(lib.effectiveTag(items, "u1"), undefined);
		assert.equal(lib.effectiveTag(items, "missing"), undefined);
	});

	it("libraryPath joins the ancestor chain", () => {
		assert.equal(lib.libraryPath(items, "q1"), "Math 3339/Unit 1/Quizzes/quiz1.pdf");
	});

	it("resolveAttachmentFiles expands folders, dedupes, drops unknown ids", () => {
		const ids = lib.resolveAttachmentFiles(items, ["u1", "q1", "gone"]).map((i) => i.id);
		// Tree order: Lectures before Quizzes; "quiz1-key" sorts before "quiz1.".
		assert.deepEqual(ids, ["l1", "q1key", "q1"]);
		assert.deepEqual(lib.resolveAttachmentFiles(items, ["course"]).map((i) => i.id), ["l1", "q1key", "q1", "syll"]);
	});

	it("isInLibrarySubtree is the move gate", () => {
		assert.equal(lib.isInLibrarySubtree(items, "course", "quizzes"), true);
		assert.equal(lib.isInLibrarySubtree(items, "u1", "u1"), true);
		assert.equal(lib.isInLibrarySubtree(items, "quizzes", "lectures"), false);
	});

	it("ancestor walks terminate on cycles", () => {
		const cyclic = [folder("a", "b", "A"), folder("b", "a", "B")];
		assert.deepEqual(lib.libraryAncestors(cyclic, "a").map((i) => i.id), ["b"]);
		assert.equal(lib.libraryPath(cyclic, "a"), "B/A");
	});
});

describe("library store (fs adapter)", () => {
	it("creates folders and files, copies bytes, hashes content, announces", () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "library-changed") announces++;
		});
		const course = libraryStore.createFolder(null, " Math 3339 ");
		assert.equal(course.name, "Math 3339");
		const bytes = new TextEncoder().encode("%PDF-fake");
		const f = libraryStore.addFile(course.id, "quiz1.pdf", bytes, PDF);
		assert.equal(f.file?.status, "processing");
		assert.equal(f.file?.bytes, bytes.byteLength);
		assert.match(f.file?.sha256 ?? "", /^[0-9a-f]{64}$/);
		assert.deepEqual(new Uint8Array(fs.readFileSync(libraryStore.originalPath(f.id))), bytes);
		assert.equal(announces, 2);
		off();
	});

	it("rejects parents that are missing or files", () => {
		const f = libraryStore.addFile(null, "loose.pdf", new Uint8Array([1]), PDF);
		assert.throws(() => libraryStore.createFolder("fld_nope", "X"), /Folder not found/);
		assert.throws(() => libraryStore.createFolder(f.id, "X"), /inside folders/);
	});

	it("updateItem renames, retags, clears tags, and refuses cyclic moves", () => {
		const a = libraryStore.createFolder(null, "A");
		const b = libraryStore.createFolder(a.id, "B");
		assert.equal(libraryStore.updateItem(b.id, { tag: "lecture" }).tag, "lecture");
		assert.equal(libraryStore.updateItem(b.id, { tag: null }).tag, undefined);
		assert.equal(libraryStore.updateItem(b.id, { name: "Bee" }).name, "Bee");
		assert.throws(() => libraryStore.updateItem(a.id, { parentId: b.id }), /into itself/);
		assert.throws(() => libraryStore.updateItem(a.id, { parentId: a.id }), /into itself/);
		assert.equal(libraryStore.updateItem(b.id, { parentId: null }).parentId, null);
	});

	it("setFileMeta merges and an explicit undefined clears", () => {
		const f = libraryStore.addFile(null, "deck.pdf", new Uint8Array([1, 2]), PDF);
		libraryStore.setFileMeta(f.id, { status: "failed", error: "boom" });
		const ok = libraryStore.setFileMeta(f.id, { status: "ready", via: "pdf", pages: 3, error: undefined });
		assert.equal(ok.file?.status, "ready");
		assert.equal(ok.file?.pages, 3);
		assert.equal("error" in (ok.file ?? {}), false);
	});

	it("deleteItem removes the subtree's records and bytes", () => {
		const top = libraryStore.createFolder(null, "Doomed");
		const inner = libraryStore.createFolder(top.id, "Inner");
		const f = libraryStore.addFile(inner.id, "x.pdf", new Uint8Array([9]), PDF);
		const dir = path.dirname(libraryStore.originalPath(f.id));
		const removed = libraryStore.deleteItem(top.id);
		assert.deepEqual(new Set(removed), new Set([top.id, inner.id, f.id]));
		assert.equal(libraryStore.getItem(f.id), null);
		assert.equal(fs.existsSync(dir), false);
		assert.deepEqual(libraryStore.deleteItem(top.id), []);
	});

	it("summaries and derived artifacts round-trip", () => {
		const f = libraryStore.addFile(null, "s.pdf", new Uint8Array([5]), PDF);
		assert.equal(libraryStore.readSummary(f.id), null);
		const summary = { sha256: f.file!.sha256, text: "Covers limits.", generatedAt: "now", model: "p:m" };
		libraryStore.writeSummary(f.id, summary);
		assert.deepEqual(libraryStore.readSummary(f.id), summary);
		libraryStore.writeDerived(f.id, "extracted.json", "{}");
		assert.equal(fs.readFileSync(libraryStore.derivedPath(f.id, "extracted.json"), "utf-8"), "{}");
	});

	it("refuses a newer-stamped index instead of rewriting it", () => {
		const indexFile = path.join(TMP_DATA, "library", "index.json");
		const original = fs.readFileSync(indexFile, "utf-8");
		fs.writeFileSync(indexFile, JSON.stringify({ version: 999, items: [] }));
		assert.throws(() => libraryStore.listItems(), /schema version 999/);
		assert.throws(() => libraryStore.createFolder(null, "X"), /schema version 999/);
		assert.equal(JSON.parse(fs.readFileSync(indexFile, "utf-8")).version, 999);
		fs.writeFileSync(indexFile, original);
	});
});

describe("chat attachments", () => {
	it("saveAttachments is replace-whole, silent, keeps updatedAt, and stays out of the list payload", () => {
		const chat = chatStore.createChat("Attach fixture");
		let announces = 0;
		const off = subscribe(() => announces++);
		chatStore.saveAttachments(chat.id, ["fld_a", "file_b"]);
		assert.deepEqual(chatStore.getChat(chat.id)?.attachments, ["fld_a", "file_b"]);
		assert.equal(chatStore.getChat(chat.id)?.updatedAt, chat.updatedAt);
		const row = chatStore.listChats().find((c) => c.id === chat.id) as unknown as Record<string, unknown>;
		assert.equal("attachments" in row, false);
		chatStore.saveAttachments(chat.id, []);
		assert.equal("attachments" in (chatStore.getChat(chat.id) ?? {}), false);
		assert.equal(announces, 0);
		off();
	});
});

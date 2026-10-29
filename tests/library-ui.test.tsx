/**
 * COURSE LIBRARY — render pins (course library wave, 2026-10-29): the pure
 * bodies of the library page rows, the delete confirm (owner ruling: warn
 * with the chats that use it, then detach), the Materials panel, and the
 * composer's attach chip — via renderToStaticMarkup, no DOM library.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ChatAttachmentsSnapshot, LibraryItem, LibrarySnapshot } from "../src/core/contracts.ts";
import { DeleteLibraryBody, FolderContents, TagSelect } from "../components/library/library-view.tsx";
import { MaterialsPanelBody } from "../components/library/materials-panel.tsx";
import { MaterialsControl } from "../components/composer-actions.tsx";

const now = "2026-10-29T00:00:00.000Z";
const folder = (id: string, parentId: string | null, name: string, tag?: LibraryItem["tag"]): LibraryItem => ({
	id, parentId, kind: "folder", name, createdAt: now, updatedAt: now, ...(tag ? { tag } : {}),
});
const file = (id: string, parentId: string, name: string, over: Partial<NonNullable<LibraryItem["file"]>> = {}): LibraryItem => ({
	id, parentId, kind: "file", name, createdAt: now, updatedAt: now,
	file: { ext: "pdf", mime: "application/pdf", format: "pdf", bytes: 2048, sha256: "x", status: "ready", via: "pdf", pages: 3, ...over },
});

const noop = () => {};

function contents(snapshot: LibrarySnapshot | null, folderId: string | null) {
	return renderToStaticMarkup(createElement(FolderContents, {
		snapshot, folderId, renamingId: null,
		onOpenFolder: noop, onRename: noop, onCommitRename: noop, onTag: noop, onMove: noop, onDelete: noop, onDropItem: noop,
	}));
}

describe("library page rows", () => {
	const items = [
		folder("c", null, "Math 3339"),
		folder("q", "c", "Quizzes", "quiz"),
		file("f1", "q", "quiz1.pdf"),
		file("f2", "q", "deck.pptx", { format: "pptx", via: "extracted", pages: 12, status: "processing" }),
		file("f3", "q", "broken.pdf", { status: "failed", error: "Invalid PDF" }),
	];
	const snapshot: LibrarySnapshot = { items, summaries: { f1: "pending" }, libreOffice: false };

	it("an empty top level explains the course → unit → type structure", () => {
		const html = contents({ items: [], summaries: {}, libreOffice: true }, null);
		assert.match(html, /data-testid="library-empty"/);
		assert.match(html, /Math 3339 → Unit 1 → Quizzes/);
	});

	it("files show units, size, inherited tags, and import/summary state", () => {
		const html = contents(snapshot, "q");
		assert.equal((html.match(/data-testid="library-row"/g) ?? []).length, 3);
		assert.match(html, /3 pages · 2 KB/);
		assert.match(html, /12 slides/);
		assert.match(html, /Summarizing/);
		assert.match(html, /Importing/);
		assert.match(html, /Import failed/);
		assert.match(html, /data-inherited="true"[^>]*>Quiz</, "the folder's tag shows as inherited");
		assert.match(html, /href="\/api\/library\/files\/f1\/content"/);
	});

	it("the tag select offers Inherit (folder tag) plus every tag", () => {
		const html = renderToStaticMarkup(createElement(TagSelect, { inherited: "quiz", onChange: noop }));
		assert.match(html, /Inherit \(Quiz\)/);
		for (const label of ["Lecture", "Quiz", "Practice Test", "Answer Key", "Homework", "Notes", "Syllabus"]) {
			assert.match(html, new RegExp(`>${label}<`));
		}
		assert.match(renderToStaticMarkup(createElement(TagSelect, { onChange: noop })), />No tag</);
	});
});

describe("delete confirm", () => {
	it("lists the chats that use it and says they'll be detached", () => {
		const html = renderToStaticMarkup(createElement(DeleteLibraryBody, {
			item: { name: "Unit 1", kind: "folder" },
			impact: { itemIds: ["u", "a", "b"], chats: [{ id: "c1", title: "Limits prep" }, { id: "c2", title: "Quiz review" }] },
			busy: false, failure: null, onClose: noop, onRun: noop,
		}));
		assert.match(html, /Delete folder\?/);
		assert.match(html, /the 2 items inside it/);
		assert.match(html, /Used by 2 chats\. It will be detached from:/);
		assert.match(html, /Limits prep/);
		assert.match(html, /Past messages that used it stay as they are/);
	});

	it("Delete waits for the impact check", () => {
		const html = renderToStaticMarkup(createElement(DeleteLibraryBody, {
			item: { name: "x.pdf", kind: "file" }, impact: null, busy: false, failure: null, onClose: noop, onRun: noop,
		}));
		assert.match(html, /Checking which chats use it/);
		assert.match(html, /data-testid="library-delete-confirm"[^>]*disabled=""/);
	});
});

describe("materials panel + composer chip", () => {
	const snapshot: ChatAttachmentsSnapshot = {
		attachments: ["u1"],
		items: [{ id: "u1", kind: "folder", name: "Unit 1", path: "Math 3339/Unit 1", fileCount: 2 }],
		files: [
			{ id: "f1", name: "quiz1.pdf", path: "Math 3339/Unit 1/quiz1.pdf", tag: "quiz", format: "pdf", status: "ready", pages: 3, summary: "ready" },
			{ id: "f2", name: "deck.pptx", path: "Math 3339/Unit 1/deck.pptx", tag: "lecture", format: "pptx", status: "ready", summary: "pending" },
		],
	};

	it("shows attached items, in-scope files, and the summary wait", () => {
		const html = renderToStaticMarkup(createElement(MaterialsPanelBody, { snapshot, reading: true, error: null, onDetach: noop, onOpenPicker: noop }));
		assert.match(html, /Unit 1/);
		assert.match(html, /2 files/);
		assert.match(html, /In scope \(2\)/);
		assert.match(html, /your next message waits for this/);
		assert.match(html, /aria-label="Detach Unit 1"/);
	});

	it("an empty chat explains what attaching does", () => {
		const html = renderToStaticMarkup(createElement(MaterialsPanelBody, {
			snapshot: { attachments: [], items: [], files: [] }, reading: false, error: null, onDetach: noop, onOpenPicker: noop,
		}));
		assert.match(html, /plan from the lectures and work toward the quizzes/);
	});

	it("the composer chip reads Attach materials / N materials attached", () => {
		assert.match(renderToStaticMarkup(createElement(MaterialsControl, { count: 0, onOpen: noop, onClear: noop })), /Attach materials/);
		const two = renderToStaticMarkup(createElement(MaterialsControl, { count: 2, onOpen: noop, onClear: noop }));
		assert.match(two, /2 materials attached/);
		assert.match(two, /data-testid="materials-clear"/);
	});
});

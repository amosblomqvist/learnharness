/**
 * COURSE LIBRARY — render pins (course library wave, 2026-10-29; Library
 * page on main's SourceFolderTree, owner ruling 2026-11-03): the
 * library→tree adapter, main's tree rendering library data with lean file
 * rows, the checked-items toolbar (file-only tags), the delete confirm
 * (warn with the chats that use it, then detach), the Materials panel, and
 * the composer's attach chip — via renderToStaticMarkup, no DOM library.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ChatAttachmentsSnapshot, LibraryItem, LibrarySnapshot } from "../src/core/contracts.ts";
import { toggleSourceEntries } from "../src/core/source-selection.ts";
import { DeleteLibraryBody, LibraryFileRow, LibraryTree, SelectionToolbar } from "../components/library/library-view.tsx";
import { EMPTY_SELECTION, libraryDirectory, libraryTreeFiles, pruneSelection, rowClickSelection, rowRange, toggleLibraryEntries, toggleRowSelection, unionSelection, singleCheckedFolder, topMostSelected } from "../components/library/library-tree.ts";
import { SourceFolderTree } from "../components/source-folder-tree.tsx";
import { PickerTree } from "../components/library/library-picker.tsx";
import { MaterialsPanelBody } from "../components/library/materials-panel.tsx";
import { MaterialsControl } from "../components/composer-actions.tsx";

const now = "2026-10-29T00:00:00.000Z";
const folder = (id: string, parentId: string | null, name: string): LibraryItem => ({
	id, parentId, kind: "folder", name, createdAt: now, updatedAt: now,
});
const file = (id: string, parentId: string | null, name: string, over: Partial<NonNullable<LibraryItem["file"]>> = {}, tag?: LibraryItem["tag"]): LibraryItem => ({
	id, parentId, kind: "file", name, createdAt: now, updatedAt: now, ...(tag ? { tag } : {}),
	file: { ext: "pdf", mime: "application/pdf", format: "pdf", bytes: 2048, sha256: "x", status: "ready", via: "pdf", pages: 3, ...over },
});

const noop = () => {};

const items = [
	folder("c", null, "Math 3339"),
	folder("u1", "c", "Unit 1"),
	file("f1", "u1", "quiz1.pdf", {}, "quiz"),
	file("f2", "u1", "deck.pptx", { format: "pptx", via: "extracted", pages: 12, status: "processing" }),
	file("f3", "c", "broken.pdf", { status: "failed", error: "Invalid PDF" }),
	file("loose", null, "syllabus.pdf", {}, "syllabus"),
];
const snapshot: LibrarySnapshot = { items, summaries: { f1: "pending" }, libreOffice: false };

describe("library → tree adapter", () => {
	it("folders, placements, and file 'sources' mirror the library", () => {
		const dir = libraryDirectory(items);
		assert.deepEqual(dir.organization.folders.map((f) => [f.id, f.parentId]), [["c", null], ["u1", "c"]]);
		assert.deepEqual(dir.organization.placements, { f1: { folderId: "u1" }, f2: { folderId: "u1" }, f3: { folderId: "c" }, loose: { folderId: null } });
		assert.deepEqual(dir.sources.map((s) => s.id), ["f1", "f2", "f3", "loose"]);
		assert.deepEqual(libraryTreeFiles(items).map((f) => [f.key, f.nodeIds]), [["f1", ["f1"]], ["f2", ["f2"]], ["f3", ["f3"]], ["loose", ["loose"]]]);
	});

	it("checking a folder checks its subtree; top-most collapses to the folder", () => {
		const dir = libraryDirectory(items);
		const sel = toggleSourceEntries(dir, EMPTY_SELECTION, "folder", "c", true);
		assert.deepEqual(new Set(sel.sources), new Set(["f1", "f2", "f3"]));
		assert.deepEqual(new Set(sel.folders), new Set(["c", "u1"]));
		assert.deepEqual(topMostSelected(items, sel).map((i) => i.id), ["c"]);
		assert.equal(singleCheckedFolder(items, sel, new Set(["c"])), "c");
	});

	it("the target is the folder you clicked, not a parent main auto-checked", () => {
		const only = [folder("c", null, "Math 3339"), folder("u1", "c", "Unit 1")];
		const sel = toggleSourceEntries(libraryDirectory(only), EMPTY_SELECTION, "folder", "u1", true);
		assert.ok(sel.folders.has("c"), "main checks the parent once its only child is checked");
		assert.equal(singleCheckedFolder(only, sel, new Set(["u1"])), "u1");
		assert.equal(singleCheckedFolder(only, sel, new Set()), null, "nothing clicked → top level");
	});

	it("loose files beside a folder mean no single upload target", () => {
		const dir = libraryDirectory(items);
		let sel = toggleSourceEntries(dir, EMPTY_SELECTION, "folder", "u1", true);
		assert.equal(singleCheckedFolder(items, sel, new Set(["u1"])), "u1");
		sel = toggleSourceEntries(dir, sel, "source", "loose", true);
		assert.equal(singleCheckedFolder(items, sel, new Set(["u1"])), null);
		assert.deepEqual(topMostSelected(items, sel).map((i) => i.id).sort(), ["loose", "u1"]);
	});

	it("Library checks never check a folder from below", () => {
		const only = [folder("c", null, "Math 3339"), folder("u1", "c", "Unit 1"), file("solo", "u1", "solo.pdf")];
		const dir = libraryDirectory(only);
		const sel = toggleLibraryEntries(dir, EMPTY_SELECTION, "source", "solo", true);
		assert.deepEqual([...sel.sources], ["solo"]);
		assert.deepEqual([...sel.folders], [], "the only file's folder stays unchecked");
		assert.deepEqual(topMostSelected(only, sel).map((i) => i.id), ["solo"], "Rename targets the file");
		assert.deepEqual(rowClickSelection(dir, EMPTY_SELECTION, "source", "solo"), sel);
	});

	it("checking a folder selects its whole subtree", () => {
		const sel = toggleLibraryEntries(libraryDirectory(items), EMPTY_SELECTION, "folder", "c", true);
		assert.deepEqual(new Set(sel.sources), new Set(["f1", "f2", "f3"]));
		assert.deepEqual(new Set(sel.folders), new Set(["c", "u1"]));
	});

	it("unchecking inside a checked folder unchecks it and its ancestors, keeping the rest", () => {
		const dir = libraryDirectory(items);
		const all = toggleLibraryEntries(dir, EMPTY_SELECTION, "folder", "c", true);
		const sel = toggleLibraryEntries(dir, all, "source", "f1", false);
		assert.deepEqual(new Set(sel.sources), new Set(["f2", "f3"]));
		assert.deepEqual([...sel.folders], [], "u1 and c both drop out");
		assert.deepEqual(topMostSelected(items, sel).map((i) => i.id).sort(), ["f2", "f3"]);
		const unit = toggleLibraryEntries(dir, all, "folder", "u1", false);
		assert.deepEqual([...unit.sources], ["f3"]);
		assert.deepEqual([...unit.folders], []);
	});

	it("Cmd/Ctrl-click toggles one row and leaves the rest", () => {
		const dir = libraryDirectory(items);
		const one = rowClickSelection(dir, EMPTY_SELECTION, "source", "f1");
		const two = toggleRowSelection(dir, one, "source", "loose");
		assert.deepEqual(new Set(two.sources), new Set(["f1", "loose"]));
		assert.deepEqual([...toggleRowSelection(dir, two, "source", "f1").sources], ["loose"]);
		const withFolder = toggleRowSelection(dir, two, "folder", "u1");
		assert.deepEqual(new Set(withFolder.sources), new Set(["f1", "f2", "loose"]));
		assert.deepEqual([...toggleRowSelection(dir, withFolder, "folder", "u1").sources], ["loose"]);
	});

	it("a shift range covers the rows between, and folders bring their contents", () => {
		const dir = libraryDirectory(items);
		const rows = [
			{ kind: "folder" as const, id: "c" }, { kind: "folder" as const, id: "u1" }, { kind: "source" as const, id: "f2" },
			{ kind: "source" as const, id: "f1" }, { kind: "source" as const, id: "f3" }, { kind: "source" as const, id: "loose" },
		];
		assert.deepEqual(rowRange(rows, "f3", "f2").map((r) => r.id), ["f2", "f1", "f3"], "either direction");
		assert.deepEqual(rowRange(rows, "gone", "f2"), [], "no visible anchor → no range");
		const sel = unionSelection(dir, rowRange(rows, "u1", "f1"));
		assert.deepEqual(new Set(sel.sources), new Set(["f1", "f2"]));
		assert.deepEqual([...sel.folders], ["u1"]);
		const all = unionSelection(dir, rows);
		assert.deepEqual(new Set(all.folders), new Set(["c", "u1"]));
		assert.deepEqual(new Set(all.sources), new Set(["f1", "f2", "f3", "loose"]));
	});

	it("a file row click selects only that file", () => {
		const dir = libraryDirectory(items);
		const several = toggleSourceEntries(dir, toggleSourceEntries(dir, EMPTY_SELECTION, "source", "f3", true), "source", "loose", true);
		const sel = rowClickSelection(dir, several, "source", "f1");
		assert.deepEqual([...sel.sources], ["f1"]);
		assert.deepEqual([...sel.folders], []);
	});

	it("a folder row click selects only that folder's subtree", () => {
		const dir = libraryDirectory(items);
		const sel = rowClickSelection(dir, toggleSourceEntries(dir, EMPTY_SELECTION, "source", "loose", true), "folder", "u1");
		assert.deepEqual(new Set(sel.sources), new Set(["f1", "f2"]));
		assert.deepEqual(new Set(sel.folders), new Set(["u1"]));
	});

	it("clicking the row that is already the whole selection clears it", () => {
		const dir = libraryDirectory(items);
		const file1 = rowClickSelection(dir, EMPTY_SELECTION, "source", "f1");
		assert.equal(rowClickSelection(dir, file1, "source", "f1"), EMPTY_SELECTION);
		const unit = rowClickSelection(dir, EMPTY_SELECTION, "folder", "u1");
		assert.equal(rowClickSelection(dir, unit, "folder", "u1"), EMPTY_SELECTION);
		const both = toggleSourceEntries(dir, file1, "source", "loose", true);
		assert.deepEqual([...rowClickSelection(dir, both, "source", "f1").sources], ["f1"], "one of several stays selected alone");
	});

	it("prunes ids that disappeared", () => {
		const sel = { sources: new Set(["f1", "gone"]), folders: new Set(["u1", "gone-folder"]) };
		const pruned = pruneSelection(items, sel);
		assert.deepEqual([...pruned.sources], ["f1"]);
		assert.deepEqual([...pruned.folders], ["u1"]);
		assert.equal(pruneSelection(items, pruned), pruned, "unchanged selections keep identity");
	});
});

describe("library page tree (main's SourceFolderTree)", () => {
	const render = (expanded: string[], selection = EMPTY_SELECTION) => renderToStaticMarkup(createElement(LibraryTree, {
		files: libraryTreeFiles(items), snapshot, directory: libraryDirectory(items), query: "",
		sort: { col: "name", dir: 1 }, selection, expanded: new Set(expanded), onToggleExpanded: noop,
		onAction: async () => {},
	}));

	it("renders main's folder rows with file counts, and lean file rows when expanded", () => {
		const html = render(["c", "u1"]);
		assert.match(html, /data-testid="folder-row-c"/);
		assert.match(html, /data-testid="folder-row-u1"/);
		assert.match(html, /data-testid="library-file-f1"/);
		assert.match(html, /data-testid="library-file-loose"/);
		assert.match(html, /3 pages · 2 KB/);
		assert.match(html, /12 slides/);
		assert.match(html, /Summarizing/);
		assert.match(html, /Importing/);
		assert.match(html, /Import failed/);
		assert.match(html, />Quiz</);
		assert.match(html, /href="\/api\/library\/files\/f1\/content"/);
	});

	it("collapsed folders hide their files; top-level files stay visible", () => {
		const html = render([]);
		assert.doesNotMatch(html, /data-testid="library-file-f1"/);
		assert.match(html, /data-testid="library-file-loose"/);
	});

	it("selected files render tinted and focusable, with no checkbox", () => {
		const html = renderToStaticMarkup(createElement(LibraryFileRow, {
			file: items[2]!, depth: 2, selected: true, onRename: async () => {},
		}));
		assert.match(html, /data-testid="library-file-f1"[^>]*data-selected="true"[^>]*tabindex="-1"[^>]*class="[^"]*bg-primary\/10/);
		assert.doesNotMatch(html, /type="checkbox"/);
		assert.match(html, /padding-left:84px/);
	});

	it("the Library tree has no checkboxes at all", () => {
		assert.doesNotMatch(render(["c", "u1"]), /type="checkbox"/);
	});

	it("names are plain text; only the row being renamed shows the edit box", () => {
		const html = render(["c", "u1"]);
		assert.doesNotMatch(html, /title="Rename"/, "no click-to-rename on any name");
		assert.doesNotMatch(html, /data-testid="source-name-input"/);
		const tree = (renaming: string) => renderToStaticMarkup(createElement(LibraryTree, {
			files: libraryTreeFiles(items), snapshot, directory: libraryDirectory(items), query: "",
			sort: { col: "name", dir: 1 }, selection: EMPTY_SELECTION, expanded: new Set(["c", "u1"]), onToggleExpanded: noop,
			renaming, onAction: async () => {},
		}));
		assert.match(tree("f1"), /data-testid="library-file-f1"[\s\S]*?data-testid="source-name-input"[^>]*value="quiz1.pdf"/);
		assert.match(tree("u1"), /data-testid="folder-row-u1"[\s\S]*?data-testid="source-name-input"[^>]*value="Unit 1"/);
		assert.equal(tree("u1").match(/source-name-input/g)?.length, 1);
	});

	it("selected file and folder rows are tinted; row clicks are opt-in", () => {
		const sel = toggleSourceEntries(libraryDirectory(items), EMPTY_SELECTION, "folder", "u1", true);
		const plain = render(["c", "u1"], sel);
		assert.doesNotMatch(plain, /cursor-pointer/, "no row-click handler, no pointer");
		const html = renderToStaticMarkup(createElement(LibraryTree, {
			files: libraryTreeFiles(items), snapshot, directory: libraryDirectory(items), query: "",
			sort: { col: "name", dir: 1 }, selection: sel, expanded: new Set(["c", "u1"]), onToggleExpanded: noop,
			onRowClick: noop, onAction: async () => {},
		}));
		assert.match(html, /data-testid="folder-row-u1"[^>]*data-selected="true"[^>]*class="[^"]*cursor-pointer[^"]*bg-primary\/10/);
		assert.match(html, /data-testid="library-file-f1"[^>]*data-selected="true"[^>]*class="[^"]*bg-primary\/10/);
		assert.doesNotMatch(html, /data-testid="folder-row-c"[^>]*data-selected/);
		assert.doesNotMatch(html, /data-testid="library-file-loose"[^>]*data-selected/);
	});
});

describe("graph sources folder tree keeps click-to-rename", () => {
	it("without folderRename, folder names stay rename buttons", () => {
		const html = renderToStaticMarkup(createElement(SourceFolderTree, {
			groups: libraryTreeFiles(items), directory: libraryDirectory(items), query: "", sort: { col: "name", dir: 1 },
			renderSource: () => null, onAction: async () => {}, expanded: new Set<string>(), onToggleExpanded: noop,
			selection: new Set<string>(), selectedFolders: new Set<string>(), onToggleNodes: noop, onToggleFolder: noop,
		}));
		assert.match(html, /title="Rename"[^>]*>Math 3339</);
		assert.match(html, /data-testid="folder-checkbox-c"/, "graph sources keep their folder checkboxes");
	});
});

describe("attach picker rows", () => {
	it("picked rows are tinted and clickable; covered rows are not clickable", () => {
		const html = renderToStaticMarkup(createElement(PickerTree, { items, parentId: null, depth: 0, picked: ["c"], coveredBy: null, onToggle: noop }));
		assert.match(html, /data-testid="pick-row-c"[^>]*data-selected="true"[^>]*class="[^"]*cursor-pointer[^"]*bg-primary\/10/);
		assert.match(html, /data-testid="pick-row-loose"[^>]*class="[^"]*cursor-pointer/);
		assert.doesNotMatch(html, /data-testid="pick-row-loose"[^>]*data-selected/);
		assert.match(html, /data-testid="pick-row-u1"[^>]*data-selected="true"[^>]*class="(?![^"]*cursor-pointer)/, "covered by c");
	});
});

describe("checked-items toolbar", () => {
	const quiz = items[2]!, deck = items[3]!, c = items[0]!;

	it("counts files and folders, and shows a single file's tag", () => {
		const html = renderToStaticMarkup(createElement(SelectionToolbar, { checked: [quiz], files: [quiz], onTag: noop, onRename: noop, onMove: noop, onDelete: noop, onClear: noop }));
		assert.match(html, /1 file selected/);
		assert.match(html, /<option value="quiz" selected="">Quiz<\/option>/);
	});

	it("several files show a neutral Tag… prompt; folders only disable tagging", () => {
		const many = renderToStaticMarkup(createElement(SelectionToolbar, { checked: [c], files: [quiz, deck], onTag: noop, onRename: noop, onMove: noop, onDelete: noop, onClear: noop }));
		assert.match(many, /2 files, 1 folder selected/);
		assert.match(many, /<option value="__mixed" selected="">Tag…<\/option>/);
		const foldersOnly = renderToStaticMarkup(createElement(SelectionToolbar, { checked: [c], files: [], onTag: noop, onRename: noop, onMove: noop, onDelete: noop, onClear: noop }));
		assert.match(foldersOnly, /data-testid="library-toolbar-tag"[^>]*disabled=""/);
		for (const label of ["Lecture", "Quiz", "Practice Test", "Answer Key", "Homework", "Notes", "Syllabus", "No tag"]) {
			assert.match(foldersOnly, new RegExp(`>${label}<`));
		}
	});
	it("with no selection it still renders, reading No selection with every control disabled", () => {
		const html = renderToStaticMarkup(createElement(SelectionToolbar, { checked: [], files: [], onTag: noop, onRename: noop, onMove: noop, onDelete: noop, onClear: noop }));
		assert.match(html, />No selection</);
		for (const id of ["tag", "move", "delete", "clear"]) assert.match(html, new RegExp(`data-testid="library-toolbar-${id}"[^>]*disabled=""|disabled=""[^>]*data-testid="library-toolbar-${id}"`));
	});

	it("Rename is enabled only for exactly one selected item", () => {
		const disabled = (html: string) => /<button[^>]*data-testid="library-toolbar-rename"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="library-toolbar-rename"/.test(html);
		const render = (checked: LibraryItem[]) => renderToStaticMarkup(createElement(SelectionToolbar, { checked, files: [], onTag: noop, onRename: noop, onMove: noop, onDelete: noop, onClear: noop }));
		assert.match(render([c]), />Rename…</);
		assert.equal(disabled(render([c])), false);
		assert.equal(disabled(render([])), true);
		assert.equal(disabled(render([c, quiz])), true);
	});

	it("a selection enables Move, Delete, and Clear", () => {
		const html = renderToStaticMarkup(createElement(SelectionToolbar, { checked: [c], files: [], onTag: noop, onRename: noop, onMove: noop, onDelete: noop, onClear: noop }));
		for (const id of ["move", "delete", "clear"]) assert.doesNotMatch(html, new RegExp(`<button[^>]*data-testid="library-toolbar-${id}"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="library-toolbar-${id}"`));
	});
});

describe("delete confirm", () => {
	it("lists the chats that use it and says they'll be detached", () => {
		const html = renderToStaticMarkup(createElement(DeleteLibraryBody, {
			items: [{ name: "Unit 1", kind: "folder" }],
			impact: { itemIds: ["u", "a", "b"], chats: [{ id: "c1", title: "Limits prep" }, { id: "c2", title: "Quiz review" }] },
			busy: false, failure: null, onClose: noop, onRun: noop,
		}));
		assert.match(html, /Delete folder\?/);
		assert.match(html, /the 2 items inside/);
		assert.match(html, /Used by 2 chats\. It will be detached from:/);
		assert.match(html, /Limits prep/);
		assert.match(html, /Past messages that used it stay as they are/);
	});

	it("several items: one combined confirm", () => {
		const html = renderToStaticMarkup(createElement(DeleteLibraryBody, {
			items: [{ name: "a.pdf", kind: "file" }, { name: "b.pdf", kind: "file" }],
			impact: { itemIds: ["a", "b"], chats: [] }, busy: false, failure: null, onClose: noop, onRun: noop,
		}));
		assert.match(html, /Delete 2 items\?/);
		assert.match(html, /a\.pdf/);
		assert.match(html, /b\.pdf/);
		assert.doesNotMatch(html, /data-testid="library-delete-chats"/);
	});

	it("Delete waits for the impact check", () => {
		const html = renderToStaticMarkup(createElement(DeleteLibraryBody, {
			items: [{ name: "x.pdf", kind: "file" }], impact: null, busy: false, failure: null, onClose: noop, onRun: noop,
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

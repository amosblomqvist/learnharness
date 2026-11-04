/**
 * LIBRARY TREE INTERACTION (owner rulings 2026-11-03): no checkboxes — the
 * row highlight shows selection; plain / Cmd-Ctrl / Shift clicks pick the
 * selection mode; a double-click opens or expands and hands back to undo its
 * first click; Finder-style keys map to tree actions. Mounted with linkedom
 * for the DOM bits; the key map is pure.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { LibraryItem, LibrarySnapshot } from "../src/core/contracts.ts";
import { LibraryTree } from "../components/library/library-view.tsx";
import { SourceFolderTree } from "../components/source-folder-tree.tsx";
import { EMPTY_SELECTION, libraryDirectory, libraryTreeFiles, toggleLibraryEntries, treeKeyAction, type TreeRow } from "../components/library/library-tree.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

const now = "2026-11-03T00:00:00.000Z";
const items: LibraryItem[] = [
	{ id: "u1", parentId: null, kind: "folder", name: "Unit 1", createdAt: now, updatedAt: now },
	...["f1", "f2"].map((id): LibraryItem => ({
		id, parentId: "u1", kind: "file", name: `${id}.pdf`, createdAt: now, updatedAt: now,
		file: { ext: "pdf", mime: "application/pdf", format: "pdf", bytes: 1, sha256: "x", status: "ready", via: "pdf", pages: 1 },
	})),
];
const snapshot: LibrarySnapshot = { items, summaries: {}, libreOffice: false };
const directory = libraryDirectory(items);
const noop = () => {};

let root: Root | undefined, host: HTMLDivElement | undefined;
async function mount(node: React.ReactNode) {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => { root!.render(node); });
	return host;
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });

function fire(selector: string, type: string, init: { detail?: number; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) {
	const el = host!.querySelector(selector)!;
	const event = new dom.window.Event(type, { bubbles: true });
	for (const [k, v] of Object.entries({ detail: 1, shiftKey: false, metaKey: false, ctrlKey: false, ...init })) Object.defineProperty(event, k, { value: v });
	el.dispatchEvent(event);
}

describe("Library tree clicks", () => {
	it("has no folder checkbox; the graph sources tree keeps its own", async () => {
		const sel = toggleLibraryEntries(directory, EMPTY_SELECTION, "source", "f1", true);
		const lib = await mount(<LibraryTree files={libraryTreeFiles(items)} snapshot={snapshot} directory={directory} query=""
			sort={{ col: "name", dir: 1 }} selection={sel} expanded={new Set(["u1"])} onToggleExpanded={noop} />);
		assert.equal(lib.querySelector('input[type="checkbox"]'), null);
		await act(async () => { root?.unmount(); });
		host?.remove();
		const graph = await mount(<SourceFolderTree groups={libraryTreeFiles(items)} directory={directory} query="" sort={{ col: "name", dir: 1 }}
			renderSource={() => null} sourceSelection={sel} expanded={new Set(["u1"])} onToggleExpanded={noop}
			selection={sel.sources} selectedFolders={sel.folders} onToggleNodes={noop} onToggleFolder={noop} />);
		assert.ok(graph.querySelector('[data-testid="folder-checkbox-u1"]'));
	});

	it("modifier keys pick the mode; a double-click opens/expands once and hands back", async () => {
		const calls: string[] = [];
		const opened: string[] = [];
		(globalThis.window as unknown as { open: (url: string) => void }).open = (url) => { opened.push(url); };
		await mount(<LibraryTree files={libraryTreeFiles(items)} snapshot={snapshot} directory={directory} query=""
			sort={{ col: "name", dir: 1 }} selection={EMPTY_SELECTION} expanded={new Set(["u1"])}
			onToggleExpanded={(id) => calls.push(`expand ${id}`)}
			onRowClick={(kind, id, mode) => calls.push(`${mode} ${kind} ${id}`)} onRowDoubleClick={() => calls.push("undo")} />);
		await act(async () => {
			fire('[data-testid="library-file-f1"]', "click");
			fire('[data-testid="library-file-f2"]', "click", { metaKey: true });
			fire('[data-testid="library-file-f2"]', "click", { ctrlKey: true });
			fire('[data-testid="folder-row-u1"]', "click", { shiftKey: true });
		});
		assert.deepEqual(calls, ["only source f1", "toggle source f2", "toggle source f2", "range folder u1"]);
		calls.length = 0;
		await act(async () => {
			fire('[data-testid="library-file-f1"]', "click", { detail: 1 });
			fire('[data-testid="library-file-f1"]', "click", { detail: 2 });
			fire('[data-testid="library-file-f1"]', "dblclick", { detail: 2 });
			fire('[data-testid="folder-row-u1"]', "click", { detail: 1 });
			fire('[data-testid="folder-row-u1"]', "click", { detail: 2 });
			fire('[data-testid="folder-row-u1"]', "dblclick", { detail: 2 });
		});
		assert.deepEqual(calls, ["only source f1", "undo", "only folder u1", "expand u1", "undo"], "second clicks are ignored");
		assert.deepEqual(opened, ["/api/library/files/f1/content"]);
	});
});

describe("Library tree keys", () => {
	const rows: TreeRow[] = [{ kind: "folder", id: "u1" }, { kind: "source", id: "f1" }, { kind: "source", id: "f2" }];
	const key = (k: string, over: Partial<{ shift: boolean; mod: boolean; alt: boolean; onControl: boolean }> = {}) =>
		({ key: k, shift: false, mod: false, alt: false, onControl: false, ...over });
	const state = (over: Partial<{ expanded: (id: string) => boolean; hasSelection: boolean }> = {}) =>
		({ expanded: () => true, parentOf: (id: string) => items.find((i) => i.id === id)?.parentId ?? null, hasSelection: true, ...over });

	it("arrows move and select; Shift+arrows extend; ends clamp; from the tree itself they start at the first row", () => {
		assert.deepEqual(treeKeyAction(rows, 1, key("ArrowDown"), state()), { type: "select", row: rows[2], mode: "move" });
		assert.deepEqual(treeKeyAction(rows, 1, key("ArrowUp", { shift: true }), state()), { type: "select", row: rows[0], mode: "range" });
		assert.deepEqual(treeKeyAction(rows, 2, key("ArrowDown"), state()), { type: "select", row: rows[2], mode: "move" });
		assert.deepEqual(treeKeyAction(rows, -1, key("ArrowDown"), state()), { type: "select", row: rows[0], mode: "move" });
		assert.equal(treeKeyAction(rows, 1, key("ArrowDown", { mod: true }), state()), null);
	});

	it("Left collapses an open folder, else jumps to the parent; Right expands a closed folder", () => {
		assert.deepEqual(treeKeyAction(rows, 0, key("ArrowLeft"), state()), { type: "expand", id: "u1" });
		assert.deepEqual(treeKeyAction(rows, 1, key("ArrowLeft"), state()), { type: "select", row: { kind: "folder", id: "u1" }, mode: "move" });
		assert.equal(treeKeyAction(rows, 0, key("ArrowLeft"), state({ expanded: () => false })), null, "top-level, closed: nowhere to go");
		assert.deepEqual(treeKeyAction(rows, 0, key("ArrowRight"), state({ expanded: () => false })), { type: "expand", id: "u1" });
		assert.equal(treeKeyAction(rows, 0, key("ArrowRight"), state()), null);
		assert.equal(treeKeyAction(rows, 1, key("ArrowRight"), state()), null);
	});

	it("Space toggles, Enter opens a file or expands a folder; both skip a row's own buttons", () => {
		assert.deepEqual(treeKeyAction(rows, 1, key(" "), state()), { type: "select", row: rows[1], mode: "toggle" });
		assert.deepEqual(treeKeyAction(rows, 1, key("Enter"), state()), { type: "open", id: "f1" });
		assert.deepEqual(treeKeyAction(rows, 0, key("Enter"), state()), { type: "expand", id: "u1" });
		assert.equal(treeKeyAction(rows, 1, key(" ", { onControl: true }), state()), null);
		assert.equal(treeKeyAction(rows, 1, key("Enter", { onControl: true }), state()), null);
	});

	it("Esc clears only when something is selected; Cmd/Ctrl+A selects all", () => {
		assert.deepEqual(treeKeyAction(rows, 1, key("Escape"), state()), { type: "clear" });
		assert.equal(treeKeyAction(rows, 1, key("Escape"), state({ hasSelection: false })), null);
		assert.deepEqual(treeKeyAction(rows, 1, key("a", { mod: true }), state()), { type: "select-all" });
		assert.equal(treeKeyAction(rows, 1, key("a"), state()), null);
	});
});

import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableBody } from "../components/chain-table.tsx";
import { toggleSourceEntries, type SourceDirectory, type SourceEntrySelection } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
const directory: SourceDirectory = {
	organization: { version: 2, folders: [
		{ id: "f1", name: "School", parentId: null, createdAt: "2026-10-30" },
		{ id: "f2", name: "Semester", parentId: "f1", createdAt: "2026-10-30" },
	], tags: [{ id: "course", name: "Course", parentId: "f2" }, { id: "review", name: "Review", parentId: "f2" }],
	placements: { a: { tagIds: ["course", "review"] }, b: { tagIds: ["review"] } } },
	sources: ["a", "b"].map(id => ({ id, kind: "notes", label: `Source ${id}`, createdAt: "2026-10-30" })),
};
let root: Root | undefined, host: HTMLDivElement | undefined;
let selectedNodes: string[] = [];
async function mount(selectMode = false) {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); selectedNodes = [];
	function Harness() {
		const [entries, setEntries] = useState<SourceEntrySelection>({ sources: new Set(), folders: new Set() });
		const toggle = (kind: "folder" | "tag" | "source", id: string, next: boolean) => setEntries(p => toggleSourceEntries(directory, p, kind, id, next));
		return <ChainTableBody directory={directory} selectMode={selectMode}
			nodes={["a", "b"].map(id => ({ id: `n_${id}`, name: id, statement: id, aliases: [], provenance: [{ chatId: id, messageId: "m" }], createdAt: "2026-10-30" }))}
			chains={[]} sessions={{}} fileSources={{}} query="" onQuery={() => {}} sort={{ col: "name", dir: 1 }} onSort={() => {}} selection={new Set()}
			expandedClusters={new Set(["f1", "f2", JSON.stringify(["tag", "course"]), JSON.stringify(["tag", "review"]), JSON.stringify(["tag", "course", "source", "a"]), JSON.stringify(["tag", "review", "source", "a"])])}
			expandedChains={new Set(["n_a"])} onToggleCluster={() => {}} onToggleChain={() => {}}
			selectedSources={entries.sources} selectedFolders={entries.folders} onToggleSource={(id, next) => toggle("source", id, next)}
			onToggleFolder={(id, next) => toggle("folder", id, next)} onToggleTag={(id, next) => toggle("tag", id, next)}
			onToggleNodes={ids => { selectedNodes = ids; }} onClear={() => {}} onDelete={() => {}} onClose={() => {}} />;
	}
	await act(async () => root!.render(<Harness />));
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; host?.remove(); });
async function check(id: string) {
	const checkbox = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
	assert.ok(checkbox); checkbox.checked = !checkbox.checked;
	await act(async () => checkbox.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
}
it("provides no drag/drop path that can silently move material into a folder", async () => {
	await mount();
	assert.equal(document.querySelector('[draggable="true"]'), null);
	assert.equal(document.querySelector('[data-source-drag-row]'), null);
	assert.equal(document.querySelector('[data-testid="add-source-folder"]'), null);
	const before = structuredClone(directory);
	const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", { value: { getData: () => JSON.stringify({ kind: "source", id: "b" }) } });
	await act(async () => document.querySelector('[data-testid="folder-row-f1"]')!.dispatchEvent(event));
	assert.equal(event.defaultPrevented, false);
	assert.deepEqual(directory, before);
	assert.equal(document.querySelector('a[href="/tags"]')?.textContent, "Organize in Tags");
});
it("shares selection across tag appearances and gives every visible navigation row a unique key", async () => {
	await mount();
	assert.equal(document.querySelectorAll('[data-testid="cluster-checkbox-a"]').length, 2);
	const keys = [...document.querySelectorAll<HTMLElement>('[data-chain-nav-row]')].map(e => e.dataset.chainNavRow);
	assert.equal(new Set(keys).size, keys.length);
	await check("tag-checkbox-course");
	for (const checkbox of document.querySelectorAll<HTMLInputElement>('[data-testid="cluster-checkbox-a"]')) assert.equal(checkbox.checked, true);
	await check("tag-checkbox-review");
	assert.match(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent!, /2 sources/);
});
it("practice folder selection deduplicates nodes shared by multiple tags", async () => {
	await mount(true);
	await check("folder-checkbox-f1");
	assert.deepEqual(new Set(selectedNodes), new Set(["n_a", "n_b"]));
	assert.equal(selectedNodes.length, 2);
});

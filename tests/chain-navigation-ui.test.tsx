import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableBody } from "../components/chain-table.tsx";
import { chainRow, useChainNavigation } from "../components/chain-navigation.ts";
import type { SourceDirectory } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
let focused: Element | undefined, scrolled = 0, selectedText = 0;
dom.window.HTMLElement.prototype.focus = function () { focused = this; };
dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled++; };
dom.window.HTMLInputElement.prototype.select = function () { selectedText++; };
dom.window.HTMLElement.prototype.blur = function () { if (focused === this) focused = undefined; };
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused ?? document.body });
const directory: SourceDirectory = {
	organization: { version: 1, folders: [
		{ id: "outer", name: "Outer", parentId: null, createdAt: "2026-10-30" },
		{ id: "inner", name: "Inner", parentId: "outer", createdAt: "2026-10-30" },
	], placements: { a: { folderId: "inner" }, b: { folderId: null } } },
	sources: [{ id: "a", kind: "notes", label: "Book A", createdAt: "2026-10-30" }, { id: "b", kind: "notes", label: "Book B", createdAt: "2026-10-30" }],
};
const nodes = ["n1", "n2", "n3"].map((id) => ({ id, name: id, statement: id, createdAt: "2026-10-30", aliases: [], provenance: [{ chatId: "a", messageId: "m" }] }));
let root: Root | undefined, host: HTMLDivElement;
let setQuery: (q: string) => void, setEnabled: (enabled: boolean) => void;
function Harness() {
	const [query, updateQuery] = useState(""); setQuery = updateQuery;
	const [enabled, updateEnabled] = useState(true); setEnabled = updateEnabled;
	const [clusters, updateClusters] = useState(new Set<string>()), [chains, updateChains] = useState(new Set<string>());
	const toggle = (prev: Set<string>, id: string) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; };
	return <ChainTableBody keyboardActive={enabled} directory={directory} nodes={nodes} chains={[{ id: "argument", premises: ["n1"], conclusion: "n2", provenance: [], createdAt: "2026-10-30" }]}
		sessions={{}} fileSources={{}} query={query} onQuery={updateQuery} sort={{ col: "name", dir: 1 }} onSort={() => {}} selection={new Set()}
		expandedClusters={clusters} expandedChains={chains} onToggleCluster={(id) => updateClusters((p) => toggle(p, id))} onToggleChain={(id) => updateChains((p) => toggle(p, id))}
		onToggleNodes={() => { throw new Error("Navigation must not select nodes"); }} onClear={() => {}} onDelete={() => {}} onClose={() => {}}
		onOrganizationChange={async () => { throw new Error("Navigation must not mutate organization"); }} />;
}
async function mount() {
	scrolled = 0; selectedText = 0; focused = undefined;
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => { root!.render(<Harness />); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });
function active() { return document.querySelector<HTMLElement>("[data-chain-nav-active]"); }
async function key(key: string, target: Element = active() ?? document.querySelector('[data-testid="chain-table"]')!) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: key });
	await act(async () => { target.dispatchEvent(event); }); return event;
}
function activeKey() { return JSON.parse(active()?.dataset.chainNavRow ?? "null"); }
async function point(selector: string) {
	await act(async () => { document.querySelector(selector)!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
}
it("Find focuses/selects chains search, and Down enters results without changing checkbox selection", async () => {
	await mount(); await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find")); });
	const search = document.querySelector('[data-testid="chain-table-search"]')!;
	assert.equal(focused, search); assert.equal(selectedText, 1);
	assert.equal((await key("ArrowLeft", search)).defaultPrevented, false); assert.equal(focused, search);
	assert.equal((await key("ArrowDown", search)).defaultPrevented, true);
	assert.deepEqual(activeKey(), ["source", "b"]); assert.equal(focused, active()); assert.ok(scrolled > 0);
	assert.equal(document.querySelectorAll('input[type="checkbox"]:checked').length, 0);
});
it("Right enters newly rendered children; Left focuses and collapses each parent through all four layers", async () => {
	await mount(); await key("ArrowDown"); await key("ArrowDown"); assert.deepEqual(activeKey(), ["folder", "outer"]);
	await key("ArrowRight"); assert.deepEqual(activeKey(), ["folder", "inner"]);
	await key("ArrowRight"); assert.deepEqual(activeKey(), ["source", "a"]);
	await key("ArrowRight"); assert.deepEqual(activeKey(), ["chain", "a", "argument"]);
	await key("ArrowRight"); assert.deepEqual(activeKey(), ["prop", "a", "argument", "n1"]);
	await key("ArrowDown"); assert.deepEqual(activeKey(), ["prop", "a", "argument", "n2"]);
	await key("ArrowLeft"); assert.deepEqual(activeKey(), ["chain", "a", "argument"]); assert.equal(active()?.dataset.chainNavExpanded, "false");
	assert.equal(document.querySelector('[data-testid="prop-row-n1"]'), null);
	await key("ArrowLeft"); assert.deepEqual(activeKey(), ["source", "a"]);
	await key("ArrowLeft"); assert.deepEqual(activeKey(), ["folder", "inner"]);
	await key("ArrowLeft"); assert.deepEqual(activeKey(), ["folder", "outer"]); assert.equal(active()?.dataset.chainNavExpanded, "false");
});
it("Up/Down skip expanded subtrees and pointer interaction establishes the active row", async () => {
	await mount(); await key("ArrowDown"); await key("ArrowDown"); await key("ArrowRight");
	await point('[data-testid="folder-row-outer"]'); await key("ArrowUp"); assert.deepEqual(activeKey(), ["source", "b"]);
	await key("ArrowDown"); assert.deepEqual(activeKey(), ["folder", "outer"]); await key("ArrowDown"); assert.deepEqual(activeKey(), ["folder", "outer"]);
});
it("search auto-expansion permits explicit collapse and resets for a new query", async () => {
	await mount(); await act(async () => { setQuery("Book A"); });
	await key("ArrowDown"); await key("ArrowRight"); await key("ArrowRight"); assert.deepEqual(activeKey(), ["source", "a"]);
	await key("ArrowLeft"); assert.deepEqual(activeKey(), ["folder", "inner"]); assert.equal(active()?.dataset.chainNavExpanded, "false");
	assert.equal(document.querySelector('[data-testid="cluster-group-a"]'), null);
	await act(async () => { setQuery("Book"); }); assert.ok(document.querySelector('[data-testid="cluster-group-a"]'));
});
it("a foreground menu/dialog keeps both Find and arrows, even if focus was left behind it", async () => {
	await mount(); const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.appendChild(dialog);
	const before = focused;
	try {
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find")); });
		assert.equal(focused, before); assert.equal((await key("ArrowDown")).defaultPrevented, false); assert.equal(active(), null);
	} finally { dialog.remove(); }
	await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find")); });
	assert.equal(focused, document.querySelector('[data-testid="chain-table-search"]'));
});
it("removing the active row by filtering safely restarts on the first visible result", async () => {
	await mount(); await key("ArrowDown"); assert.deepEqual(activeKey(), ["source", "b"]);
	await act(async () => { setQuery("n2"); }); assert.equal(active(), null);
	await key("ArrowDown"); assert.deepEqual(activeKey(), ["folder", "outer"]);
});
it("rename arrows stay in the input, and modal-owned keyboard focus disables both Find and navigation", async () => {
	await mount(); await point('[data-source-drag-row="b"]');
	await act(async () => { (document.querySelector('[data-source-drag-row="b"] button[title="Rename"]') as HTMLElement).click(); });
	const input = document.querySelector('[data-testid="source-name-input"]')!;
	for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) assert.equal((await key(arrow, input)).defaultPrevented, false);
	assert.equal(focused, input); await act(async () => { setEnabled(false); });
	await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find")); }); assert.equal(focused, input);
	assert.equal((await key("ArrowDown", document.querySelector('[data-testid="chain-table"]')!)).defaultPrevented, false);
});
it("Space clicks only the focused row's enabled checkbox; text editing and checkbox-free chain rows retain native behavior", async () => {
	await mount(); await key("ArrowDown");
	let clicks = 0;
	const checkbox = active()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	checkbox.click = () => { clicks++; };
	assert.equal((await key(" ")).defaultPrevented, true); assert.equal(clicks, 1);
	checkbox.disabled = true; assert.equal((await key(" ")).defaultPrevented, false); assert.equal(clicks, 1);
	const search = document.querySelector('[data-testid="chain-table-search"]')!;
	assert.equal((await key(" ", search)).defaultPrevented, false);
	assert.equal((await key(" ", document.querySelector('[data-testid="sort-name"]')!)).defaultPrevented, false);
	await key("ArrowDown"); await key("ArrowRight"); await key("ArrowRight"); await key("ArrowRight");
	assert.equal(activeKey()?.[0], "chain"); assert.equal((await key(" ")).defaultPrevented, false);
});
it("blank space below the tree clears row highlighting and focus, without toggling checked entries", async () => {
	await mount(); await key("ArrowDown"); assert.ok(active()); assert.equal(focused, active());
	const checkbox = active()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.checked = true;
	await point('[data-testid="source-root-drop"]'); assert.equal(active(), null); assert.equal(focused, undefined); assert.equal(checkbox.checked, true);
});
it("programmatic focus waits for a just-created row to render, then highlights and scrolls it", async () => {
	let addRow: () => void;
	function FocusHarness() {
		const [created, setCreated] = useState(false);
		const rootRef = useRef<HTMLDivElement>(null), searchRef = useRef<HTMLInputElement>(null);
		const navigation = useChainNavigation(rootRef, searchRef, true);
		addRow = () => { navigation.focusRow(["folder", "new"]); setCreated(true); };
		return <div ref={rootRef} tabIndex={-1}><input ref={searchRef} />{created && <div {...chainRow(["folder", "new"], 0, false)}>New folder</div>}</div>;
	}
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); scrolled = 0;
	await act(async () => { root!.render(<FocusHarness />); });
	await act(async () => { addRow(); });
	assert.deepEqual(activeKey(), ["folder", "new"]); assert.equal(focused, active()); assert.ok(scrolled > 0);
});

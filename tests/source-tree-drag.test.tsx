import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableBody } from "../components/chain-table.tsx";
import type { OrganizationAction, SourceDirectory } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: () => ({ fontFamily: "monospace" }),
	requestAnimationFrame: (cb: FrameRequestCallback) => { queueMicrotask(() => cb(0)); return 1; },
});
dom.window.HTMLInputElement.prototype.select = function () {};
const directory: SourceDirectory = {
	organization: { version: 1, folders: [
		{ id: "f1", name: "Outer", parentId: null, createdAt: "2026-10-30" },
		{ id: "f2", name: "Inner", parentId: "f1", createdAt: "2026-10-30" },
	], placements: { a: { folderId: "f2" }, b: { folderId: null } } },
	sources: [{ id: "a", kind: "notes", label: "Source A", createdAt: "2026-10-30" }, { id: "b", kind: "notes", label: "Source B", createdAt: "2026-10-30" }],
};
let root: Root | undefined, host: HTMLDivElement | undefined;
let actions: OrganizationAction[];
async function mount() {
	actions = []; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => { root!.render(<ChainTableBody directory={directory} onOrganizationChange={async (a) => { actions.push(a); }}
		nodes={[{ id: "n1", name: "Node", statement: "Statement", aliases: [], provenance: [{ chatId: "a", messageId: "m1" }], createdAt: "2026-10-30" }]}
		chains={[]} sessions={{}} fileSources={{}} query="" onQuery={() => {}} sort={{ col: "name", dir: 1 }} onSort={() => {}} selection={new Set()}
		expandedClusters={new Set(["f1", "f2", "a"])} expandedChains={new Set(["n1"])} onToggleCluster={() => {}} onToggleChain={() => {}}
		onToggleNodes={() => {}} onClear={() => {}} onDelete={() => {}} onClose={() => {}} />); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); });
function transfer() {
	const data = new Map<string, string>();
	return { types: [] as string[], effectAllowed: "", dropEffect: "", preview: undefined as HTMLElement | undefined,
		setData(type: string, value: string) { data.set(type, value); this.types.push(type); }, getData(type: string) { return data.get(type) ?? ""; },
		setDragImage(element: HTMLElement) { this.preview = element; } };
}
async function fire(selector: string, type: string, data: ReturnType<typeof transfer>) {
	const target = document.querySelector(selector); assert.ok(target, selector);
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: data });
	Object.defineProperty(event, "clientX", { value: 100 }); Object.defineProperty(event, "clientY", { value: 100 });
	await act(async () => { target.dispatchEvent(event); }); return event;
}

it("dragging the name moves the item with an icon/name-only preview, not the whole row", async () => {
	await mount(); const data = transfer();
	await fire('[data-source-drag-row="b"] button[title="Rename"]', "dragstart", data);
	assert.deepEqual(JSON.parse(data.getData("application/x-learnharness-source")), { kind: "source", id: "b" });
	assert.equal(data.effectAllowed, "move"); assert.equal(data.preview?.textContent, "Source B");
	assert.equal(data.preview?.querySelectorAll("svg").length, 1); assert.equal(data.preview?.querySelectorAll("input,button").length, 0);
	assert.equal(document.querySelector('[data-testid="source-name-input"]'), null, "a drag does not enter rename mode");
});

it("folder contents, including expanded propositions, drop into their containing folder with stable background feedback", async () => {
	await mount(); const data = transfer();
	await fire('[data-source-drag-row="b"]', "dragstart", data);
	await fire('[data-testid="prop-row-n1"]', "dragover", data);
	assert.equal(document.querySelector('[data-testid="folder-row-f2"]')?.getAttribute("data-drop-active"), "true");
	assert.equal(document.querySelector('[data-testid="folder-row-f1"]')?.getAttribute("data-drop-active"), "false");
	await fire('[data-testid="prop-row-n1"]', "drop", data);
	assert.deepEqual(actions, [{ action: "move", kind: "source", id: "b", parentId: "f2" }]);
	assert.equal(document.querySelector('[data-drop-active="true"]'), null);
});

it("folder headers and unlabelled blank space below the tree accept folder/root placement", async () => {
	await mount(); const data = transfer(); await fire('[data-source-drag-row="b"]', "dragstart", data);
	await fire('[data-testid="folder-row-f1"]', "drop", data);
	await fire('[data-testid="source-root-drop"]', "drop", data);
	assert.deepEqual(actions, [{ action: "move", kind: "source", id: "b", parentId: "f1" }, { action: "move", kind: "source", id: "b", parentId: null }]);
	assert.equal(document.querySelector('[data-testid="source-root-drop"]')?.textContent, "");
});

it("dragging a folder onto its descendants neither highlights nor performs an invalid move", async () => {
	await mount(); const data = transfer(); await fire('[data-source-drag-row="f1"]', "dragstart", data);
	await fire('[data-testid="prop-row-n1"]', "dragover", data);
	assert.equal(data.dropEffect, "none"); assert.equal(document.querySelector('[data-drop-active="true"]'), null);
	await fire('[data-testid="prop-row-n1"]', "drop", data); assert.deepEqual(actions, []);
});

it("rename mode removes the drag surface and input chrome, retaining native text-selection gestures", async () => {
	await mount(); await act(async () => { (document.querySelector('[data-source-drag-row="b"] button[title="Rename"]') as HTMLElement).click(); });
	const row = document.querySelector('[data-source-drag-row="b"]')!;
	assert.equal(row.getAttribute("draggable"), "false");
	const input = row.querySelector('[data-testid="source-name-input"]')!; assert.match(input.className, /border-0 bg-transparent p-0/); assert.doesNotMatch(input.className, /rounded|focus:border/);
	const data = transfer(); const event = await fire('[data-testid="source-name-input"]', "dragstart", data);
	assert.equal(event.defaultPrevented, true); assert.equal(data.types.length, 0); assert.equal(data.preview, undefined);
});

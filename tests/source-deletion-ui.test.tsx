import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { MinimalHome } from "../components/minimal-home.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import type { SourceDirectory } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom does not implement native checkbox activation. Preserve click
// dispatch while supplying the browser's pre-click checked-state transition.
const nativeClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; nativeClick.call(this); };
let root: Root | undefined, host: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; host?.remove(); globalThis.fetch = originalFetch; });
const directory = (): SourceDirectory => ({ organization: { version: 1, folders: [], placements: {} }, sources: ["a", "b"].map((id) => ({ id, kind: "notes", label: `${id} book`, createdAt: "now" })) });
async function mount(children: React.ReactNode) {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => { root!.render(<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>{children}</ServerEventsProvider>); });
}
async function click(id: string) {
	const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(element, id);
	await act(async () => { element.click(); });
}
it("a failed deletion keeps its original confirmation targets for retry even after refresh prunes removed sources", async () => {
	let current = directory(), revisions = 0;
	const requests: { sourceIds: string[]; folderIds: string[]; deleteSessions: boolean }[] = [];
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "DELETE") {
			requests.push(JSON.parse(init.body as string));
			current = { ...current, sources: current.sources.filter((s) => s.id !== "a") };
			if (requests.length === 1) return Response.json({ error: "Some entries may already have been removed; refresh or retry." }, { status: 500 });
			return Response.json({ ...current, graphRevision: 1 });
		}
		return Response.json(current);
	};
	const onRevision = () => { revisions++; }; window.addEventListener("lh:graph-revision", onRevision);
	try {
		await mount(<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => {}} />);
		await click("cluster-checkbox-a"); await click("chain-delete"); await click("source-delete-confirm");
		assert.match(document.querySelector('[data-testid="source-delete-failure"]')!.textContent!, /Some entries/);
		assert.equal(document.querySelector('[data-testid="cluster-checkbox-a"]'), null);
		assert.match(document.querySelector('[data-testid="source-deletion-names"]')!.textContent!, /a book/);
		assert.equal(document.querySelector('[data-testid="chain-selection-bar"]'), null);
		await click("source-delete-confirm");
		assert.equal(document.querySelector('[data-testid="delete-source-dialog"]'), null);
		assert.deepEqual(requests, [{ sourceIds: ["a"], folderIds: [], deleteSessions: false }, { sourceIds: ["a"], folderIds: [], deleteSessions: false }]);
		assert.equal(revisions, 2, "even a partial/ambiguous failure refreshes graph content");
	} finally { window.removeEventListener("lh:graph-revision", onRevision); }
});
it("clearing ordinary source selection does not clear the caller's independent practice node picks", async () => {
	let changes = 0; globalThis.fetch = async () => Response.json(directory());
	await mount(<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} controlledSelection={new Set(["practice-node"])} onSelectionChange={() => { changes++; }} onClose={() => {}} />);
	await click("cluster-checkbox-a"); assert.match(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent!, /1 source/);
	await click("chain-clear"); assert.equal(document.querySelector('[data-testid="chain-selection-bar"]'), null); assert.equal(changes, 0);
});
it("minimal home refreshes its snapshot and summary immediately after source deletion, without a reload", async () => {
	let current = directory(); current.sources = current.sources.slice(0, 1);
	globalThis.fetch = async (url, init) => {
		if (init?.method === "DELETE") { current = { ...current, sources: [] }; return Response.json({ ...current, graphRevision: 1 }); }
		if (url === "/api/graph/sources") return Response.json(current);
		if (url === "/api/graph") return Response.json({ propositions: [], chains: [], sessions: {}, fileSources: current.sources.length ? { a: "a.md" } : {} });
		if (url === "/api/chats") return Response.json({ chats: [] });
		throw new Error("No synthetic cost response");
	};
	await mount(<MinimalHome />);
	assert.match(document.querySelector('[data-testid="knowledge-summary"]')!.textContent!, /1 imported note/);
	await click("open-chain-table"); await click("cluster-checkbox-a"); await click("chain-delete"); await click("source-delete-confirm");
	assert.match(document.querySelector('[data-testid="knowledge-summary"]')!.textContent!, /0 imported notes/);
	assert.equal(document.querySelector('[data-testid="cluster-checkbox-a"]'), null);
});

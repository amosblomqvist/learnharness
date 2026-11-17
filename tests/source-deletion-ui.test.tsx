import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { MinimalHome } from "../components/minimal-home.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { GraphNode, SourceDirectory } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const restoreDom = installModalDom(dom);
after(restoreDom);
// linkedom does not implement native checkbox activation. Preserve click
// dispatch while supplying the browser's pre-click checked-state transition.
const nativeClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; nativeClick.call(this); };
let root: Root | undefined, host: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => { root?.unmount(); }); root = undefined;
	// FocusScope dispatches its unmount event after React cleanup.
	await new Promise(resolve => setTimeout(resolve, 5));
	host?.remove(); globalThis.fetch = originalFetch;
});
const directory = (): SourceDirectory => ({ organization: { version: 1, folders: [], placements: {} }, sources: ["a", "b"].map((id) => ({ id, kind: "notes", label: `${id} book`, createdAt: "now" })) });
async function mount(children: React.ReactNode) {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await update(children);
}
async function update(children: React.ReactNode) {
	await act(async () => { root!.render(<InteractionLayersProvider><ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>{children}</ServerEventsProvider></InteractionLayersProvider>); });
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
const practiceDirectory = (): SourceDirectory => ({
	organization: { version: 1, folders: [{ id: "f", name: "Mixed folder", parentId: null, createdAt: "now" }], placements: { a: { folderId: "f" }, b: { folderId: "f" }, practice: { folderId: "f" } } },
	sources: [...directory().sources, { id: "practice", kind: "chat", chatKind: "practice", label: "Hidden practice", createdAt: "now" }],
});
const sourceNode = (id: string, source: string): GraphNode => ({ id, name: id, statement: id, aliases: [], createdAt: "now", provenance: [{ chatId: source, messageId: "m" }] });
it("practice provenance rows never flash before the source inventory arrives", async () => {
	let respond!: (response: Response) => void;
	globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
	await mount(<ChainTableOverlay open nodes={[sourceNode("historical", "practice")]} chains={[]} sessions={{ practice: "Hidden practice" }} fileSources={{}} onClose={() => {}} />);
	assert.equal(document.querySelector('[data-testid="cluster-group-practice"]'), null);
	await act(async () => { respond(Response.json(practiceDirectory())); });
	assert.equal(document.querySelector('[data-testid="cluster-group-practice"]'), null);
	assert.ok(document.querySelector('[data-testid="folder-checkbox-f"]'));
});
for (const selectMode of [false, true]) it(`reopening ${selectMode ? "practice picking" : "chains browsing"} waits for fresh source kinds before showing cached/provenance groups`, async () => {
	globalThis.fetch = async () => Response.json(directory());
	const changes: string[][] = [];
	const visible = sourceNode("visible", "a"), historical = sourceNode("historical", "practice"), unknown = sourceNode("legacy-unknown", "unknown");
	const overlay = (open: boolean, nodes = [visible]) => <ChainTableOverlay open={open} selectMode={selectMode} nodes={nodes} chains={[]} sessions={{ practice: "New practice" }} fileSources={{}} controlledSelection={new Set(["visible"])} onSelectionChange={(next) => changes.push([...next])} onClose={() => {}} />;
	await mount(overlay(true));
	assert.ok(document.querySelector('[data-testid="cluster-group-a"]'), "first opening loads and caches the inventory");
	await update(overlay(false));
	let respond!: (response: Response) => void;
	globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
	await update(overlay(true, [visible, historical, unknown]));
	assert.equal(document.querySelector('[data-testid="cluster-group-practice"]') === null, true, "a new practice source cannot flash through the old inventory");
	assert.equal(document.querySelector('[data-testid="cluster-checkbox-practice"]') === null, true, "the stale source cannot be selected while the refresh is delayed");
	assert.equal(document.querySelector('[data-testid="cluster-group-unknown"]') === null, true, "wait for classification, not just an old nonempty inventory");
	await act(async () => { respond(Response.json({ ...directory(), sources: [...directory().sources, { id: "practice", kind: "chat", chatKind: "practice", label: "New practice", createdAt: "now" }] })); });
	assert.equal(document.querySelector('[data-testid="cluster-group-practice"]'), null);
	assert.ok(document.querySelector('[data-testid="cluster-group-a"]'));
	assert.ok(document.querySelector('[data-testid="cluster-group-unknown"]'), "genuinely unknown provenance remains visible after a successful read");
	if (selectMode) assert.equal(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent, "1 node → 1 chain");
	assert.deepEqual(changes, [], "closing/refreshing never rewrites caller-owned picks");
});

it("an older opening's late mutation reply cannot unlock a reopened tree with stale source kinds", async () => {
	let finishDelete!: (response: Response) => void;
	globalThis.fetch = (_url, init) => init?.method === "DELETE" ? new Promise((resolve) => { finishDelete = resolve; }) : Promise.resolve(Response.json(directory()));
	const overlay = (open: boolean, nodes: GraphNode[] = []) => <ChainTableOverlay open={open} nodes={nodes} chains={[]} sessions={{ practice: "New practice" }} fileSources={{}} onClose={() => {}} />;
	await mount(overlay(true)); await click("cluster-checkbox-a"); await click("chain-delete"); await click("source-delete-confirm");
	await update(overlay(false));
	const reads: ((response: Response) => void)[] = [];
	globalThis.fetch = () => new Promise((resolve) => { reads.push(resolve); });
	await update(overlay(true, [sourceNode("historical", "practice")]));
	await act(async () => { finishDelete(Response.json({ ...directory(), graphRevision: 1 })); });
	assert.equal(document.querySelector('[data-testid="cluster-group-practice"]') === null, true, "the old response cannot reinstall stale visible groups");
	assert.equal(reads.length, 2, "reopening and the completed deletion each request fresh metadata");
	await act(async () => { for (const respond of reads) respond(Response.json({ ...directory(), sources: [...directory().sources, { id: "practice", kind: "chat", chatKind: "practice", label: "New practice", createdAt: "now" }] })); });
	assert.equal(document.querySelector('[data-testid="cluster-group-practice"]'), null);
	assert.ok(document.querySelector('[data-testid="cluster-group-a"]'));
});

it("folder selection, counts and confirmed source deletion exclude hidden practice sessions", async () => {
	let current = practiceDirectory();
	const requests: { sourceIds: string[]; folderIds: string[]; deleteSessions: boolean }[] = [];
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "DELETE") { requests.push(JSON.parse(init.body as string)); current = { ...current, sources: current.sources.filter((s) => s.chatKind === "practice") }; }
		return Response.json(current);
	};
	await mount(<ChainTableOverlay open nodes={[sourceNode("historical", "practice")]} chains={[]} sessions={{ practice: "Hidden practice" }} fileSources={{}} onClose={() => {}} />);
	await click("folder-checkbox-f");
	assert.equal(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent, "2 sources · 1 folder");
	await click("folder-icon-f");
	assert.equal(document.querySelector('[data-testid="cluster-checkbox-practice"]'), null);
	for (const id of ["a", "b"]) assert.equal(document.querySelector<HTMLInputElement>(`[data-testid="cluster-checkbox-${id}"]`)!.checked, true);
	await click("chain-delete");
	assert.doesNotMatch(document.querySelector('[data-testid="source-deletion-names"]')!.textContent!, /Hidden practice/);
	await click("source-delete-confirm");
	assert.deepEqual(requests, [{ sourceIds: ["a", "b"], folderIds: ["f"], deleteSessions: false }]);
	assert.ok(document.querySelector('[data-testid="folder-checkbox-f"]'), "the container for a kept hidden session survives");
});
it("practice folder picking omits practice-born groups and retains caller-owned picks", async () => {
	globalThis.fetch = async () => Response.json(practiceDirectory());
	const changes: string[][] = [];
	await mount(<ChainTableOverlay open selectMode nodes={[sourceNode("visible", "a"), sourceNode("historical", "practice")]} chains={[]} sessions={{ practice: "Hidden practice" }} fileSources={{}} controlledSelection={new Set(["already-picked"])} onSelectionChange={(next) => changes.push([...next])} onClose={() => {}} />);
	assert.deepEqual(changes, [], "rendering does not mutate existing practice picks");
	await click("folder-checkbox-f");
	assert.deepEqual(changes, [["already-picked", "visible"]]);
	assert.equal(document.querySelector('[data-testid="chain-delete"]'), null);
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

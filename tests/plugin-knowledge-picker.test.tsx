import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import type { GraphSnapshot, SourceDirectory } from "../src/core/index.ts";
import type { PluginKnowledgePickerProps, PluginWidgetHandle } from "../src/core/plugin-ui.ts";

// Isolate configuration before importing application modules, even in standalone runs.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-knowledge-"));
const environment = { ...process.env };
process.env.HOME = path.join(scratch, "home");
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => { process.env = environment; fs.rmSync(scratch, { recursive: true, force: true }); });
const { createPluginUiStore, PluginUiHost } = await import("../components/plugin-ui-host.tsx");
const { HostContentRootContext } = await import("../components/host-content-root.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { DeleteSourceDialog } = await import("../components/delete-source-dialog.tsx");
const { KnowledgePickerForegroundProvider } = await import("../components/knowledge-picker-foreground.tsx");
const { SessionFind } = await import("../components/session-find.tsx");

const graph: GraphSnapshot = {
	nodes: [], edges: [], logicalEdges: [], impLinks: [], nodeSessions: {}, clusters: [],
	propositions: ["a", "b"].map((id) => ({ id, name: `Node ${id}`, statement: `Statement ${id}`, aliases: [], createdAt: "2026-10-01", provenance: [{ chatId: "chat", messageId: "message" }] })),
	chains: [{ id: "chain", premises: ["a"], conclusion: "b", provenance: [], createdAt: "2026-10-01" }],
	sessions: { chat: "Lesson" }, fileSources: {},
};
const directory: SourceDirectory = {
	organization: { version: 1, folders: [], placements: {} },
	sources: [{ id: "chat", kind: "chat", label: "Lesson", createdAt: "2026-10-01" }],
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(options: { withSessionFind?: boolean; missingProvider?: boolean; missingRoot?: boolean; value?: readonly string[]; disabled?: boolean; fetch?: typeof fetch } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div><aside id='sidebar'></aside><main id='content'><div id='transcript'>Session text</div><div id='target'>plugin-owned</div></main></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	const nativeFocus = dom.window.HTMLElement.prototype.focus;
	const nativeSelect = dom.window.HTMLInputElement.prototype.select;
	dom.window.HTMLElement.prototype.focus = function () { active = this; };
	dom.window.HTMLInputElement.prototype.select = function () {};
	const nativeClick = dom.window.HTMLInputElement.prototype.click;
	dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; nativeClick.call(this); };
	const requests: { url: string; init?: RequestInit }[] = [];
	const errors: unknown[] = [];
	const values = {
		React, window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, CustomEvent: dom.window.CustomEvent,
		MutationObserver: class { observe() {} disconnect() {} },
		IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1024, innerHeight: 800,
		requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
		fetch: (async (url, init) => {
			requests.push({ url: String(url), init });
			if (options.fetch) return options.fetch(url, init);
			assert.equal(init?.method, undefined, "opening/selecting must never mutate data");
			if (url === "/api/graph") return Response.json(graph);
			assert.equal(url, "/api/graph/sources");
			return Response.json(directory);
		}) as typeof fetch,
	};
	const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const store = createPluginUiStore();
	const lifetime = new AbortController(); const scope = new AbortController();
	const ui = store.createUi({ signal: lifetime.signal, onError: (error) => errors.push(error) });
	const root = createRoot(document.querySelector("#root")!);
	const content = document.querySelector<HTMLElement>("#content")!;
	const target = document.querySelector<HTMLElement>("#target")!;
	const calls: string[][] = [];
	const notifications = new Map<string, (data: string) => void>();
	let resync = () => {};
	const connect = () => ({ close() {}, onOpen(cb: () => void) { resync = cb; }, onEvent(name: string, cb: (data: string) => void) { notifications.set(name, cb); } });
	let handle!: PluginWidgetHandle<PluginKnowledgePickerProps>;
	let showDialog!: () => void;
	let dialogClosed = 0;
	function Host() {
		const [dialog, setDialog] = useState(false);
		showDialog = () => setDialog(true);
		const body = <HostContentRootContext.Provider value={options.missingRoot ? null : content}>
				<PluginUiHost store={store} />
				{options.withSessionFind && <SessionFind scopeRef={{ current: document.querySelector<HTMLDivElement>("#transcript") }} scrollContextRef={{ current: null }} />}
				<DeleteSourceDialog open={dialog} sources={[]} folders={[]} onDelete={async () => {}} onClose={() => { dialogClosed++; setDialog(false); }} />
			</HostContentRootContext.Provider>;
		return <ServerEventsProvider connect={connect}>{options.missingProvider ? body : <KnowledgePickerForegroundProvider>{body}</KnowledgePickerForegroundProvider>}</ServerEventsProvider>;
	}
	await act(async () => {
		root.render(<Host />);
		handle = ui.mountKnowledgePicker(target, { value: options.value ?? [], disabled: options.disabled, onChange: (ids) => { calls.push([...ids]); } }, { signal: scope.signal });
	});
	return {
		dom, store, ui, lifetime, scope, handle, target, content, requests, errors, calls, showDialog,
		notify(name: string) { notifications.get(name)?.("{}"); }, resync() { resync(); },
		get dialogClosed() { return dialogClosed; },
		async dispose() {
			await act(async () => { lifetime.abort(); root.unmount(); });
			dom.window.HTMLInputElement.prototype.click = nativeClick;
			dom.window.HTMLElement.prototype.focus = nativeFocus;
			dom.window.HTMLInputElement.prototype.select = nativeSelect;
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
			}
		},
		async unmountHost() { await act(async () => root.unmount()); },
	};
}
async function click(f: Fixture, testid: string) {
	const target = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
	assert.ok(target, testid);
	await act(async () => target.dispatchEvent(new f.dom.window.Event("click", { bubbles: true })));
}
async function escape(f: Fixture, target: EventTarget = document) {
	const event = new f.dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: "Escape" });
	await act(async () => { target.dispatchEvent(event); });
	return event;
}
const overlay = () => document.querySelector('[data-testid="chain-table-overlay"]');

it("the actual chat finder yields Find to the foreground selector", async () => {
	const f = await fixture({ withSessionFind: true });
	try {
		await click(f, "practice-props-chip");
		await act(async () => { window.dispatchEvent(new f.dom.window.CustomEvent("lh:kbd-find")); });
		assert.equal(!!document.querySelector('[data-testid="session-find"]'), false, "the covered chat finder must not open");
		assert.equal(document.activeElement === document.querySelector('[data-testid="chain-table-search"]'), true);
		await click(f, "chain-table-close");
		await act(async () => { window.dispatchEvent(new f.dom.window.CustomEvent("lh:kbd-find")); });
		assert.ok(document.querySelector('[data-testid="session-find"]'), "chat retains Find after the selector closes");
	} finally { await f.dispose(); }
});

it("an already-open chat finder keeps its state and yields Escape to the foreground selector", async () => {
	const f = await fixture({ withSessionFind: true });
	try {
		await act(async () => { window.dispatchEvent(new f.dom.window.CustomEvent("lh:kbd-find")); });
		const finder = document.querySelector('[data-testid="session-find"]'); assert.ok(finder);
		await click(f, "practice-props-chip");
		await escape(f); assert.equal(!!overlay(), false);
		assert.equal(document.querySelector('[data-testid="session-find"]') === finder, true);
		await escape(f); assert.equal(!!document.querySelector('[data-testid="session-find"]'), false);
	} finally { await f.dispose(); }
});

it("a missing foreground provider reports normally without private ownership fallback", async () => {
	const f = await fixture({ missingProvider: true });
	try {
		await click(f, "practice-props-chip"); assert.equal(overlay(), null); assert.equal(f.requests.length, 0); assert.equal(f.errors.length, 1);
	} finally { await f.dispose(); }
});

it("lazily loads the actual shared picker inside the host column, with its sidebar toggle and source controls", async () => {
	const f = await fixture();
	try {
		assert.equal(f.requests.length, 0);
		assert.equal(f.target.querySelector('[data-testid="practice-props-chip"]')?.textContent, "Pick nodes");
		await click(f, "practice-props-chip");
		assert.deepEqual(f.requests.map((r) => r.url), ["/api/graph", "/api/graph/sources"]);
		assert.equal(overlay()?.parentElement, f.content);
		assert.match(overlay()!.className, /absolute inset-0/);
		assert.equal(document.querySelector("#sidebar")!.children.length, 0);
		assert.ok(overlay()!.querySelector('[data-testid="chain-table"]'));
		assert.ok(overlay()!.querySelector('[aria-label="Open sidebar"]'));
		assert.ok(overlay()!.querySelector('[data-testid="add-source-folder"]'));
		assert.ok(overlay()!.querySelector('button[title="Rename"]'));
		assert.equal(overlay()!.querySelector("[data-source-drag-row]")?.getAttribute("draggable"), "true");
		assert.equal(document.querySelector('[data-testid="chain-delete"]'), null);
	} finally { await f.dispose(); }
});

it("actual checkbox changes emit immediately; controlled updates, Done/X/Escape and reopen retain picks", async () => {
	const f = await fixture();
	try {
		await click(f, "practice-props-chip");
		// Checkbox activation in linkedom needs the native pre-click state transition.
		await act(async () => { (document.querySelector('[data-testid="cluster-checkbox-chat"]') as HTMLInputElement).click(); });
		assert.deepEqual(f.calls, [["a", "b"]]);
		assert.equal(f.target.textContent?.includes("nodes selected"), false, "selection remains caller-controlled");
		await act(async () => { f.handle.update({ value: ["a", "b", "a"] }); });
		assert.match(f.target.textContent!, /2 nodes selected/);
		for (const action of ["Done", "X", "Escape"]) {
			if (action === "Done") await click(f, "chain-practice-done");
			else if (action === "X") await click(f, "chain-table-close");
			else await escape(f);
			assert.equal(overlay(), null);
			assert.equal(document.activeElement, f.target.querySelector('[data-testid="practice-props-chip"]'));
			assert.match(f.target.textContent!, /2 nodes selected/);
			await click(f, "practice-props-chip");
			assert.equal((document.querySelector('[data-testid="cluster-checkbox-chat"]') as HTMLInputElement).checked, true);
		}
		assert.equal(f.requests.filter((r) => r.url === "/api/graph").length, 1, "one graph snapshot per widget lifetime");
		assert.equal(f.requests.filter((r) => r.url === "/api/graph/sources").length, 4, "source organization refreshes on every open");
		await click(f, "chain-clear");
		assert.deepEqual(f.calls.at(-1), []);
		await act(async () => { f.handle.update({ value: [] }); });
		assert.equal(document.querySelector('[data-testid="chain-practice-done"]'), null);
		await click(f, "chain-table-close");
		await act(async () => { f.handle.update({ value: ["b"] }); });
		await click(f, "practice-props-clear");
		assert.deepEqual(f.calls.at(-1), []);
	} finally { await f.dispose(); }
});

it("individual node and whole-chain selection use sets without pruning caller-owned IDs", async () => {
	const f = await fixture({ value: ["outside-snapshot", "outside-snapshot"] });
	try {
		await click(f, "practice-props-chip");
		await click(f, "cluster-toggle-chat");
		await click(f, "chain-toggle-chain");
		await act(async () => { (document.querySelector('[data-testid="prop-checkbox-a"]') as HTMLInputElement).click(); });
		assert.deepEqual(f.calls.at(-1), ["outside-snapshot", "a"]);
		await act(async () => { f.handle.update({ value: f.calls.at(-1)! }); });
		await act(async () => { (document.querySelector('[data-testid="chain-checkbox-chain"]') as HTMLInputElement).click(); });
		assert.deepEqual(f.calls.at(-1), ["outside-snapshot", "a", "b"]);
		await act(async () => { f.handle.update({ value: f.calls.at(-1)! }); });
		await act(async () => { (document.querySelector('[data-testid="prop-checkbox-a"]') as HTMLInputElement).click(); });
		assert.deepEqual(f.calls.at(-1), ["outside-snapshot", "b"]);
	} finally { await f.dispose(); }
});

it("controlled callbacks use latest props even before React rerenders, and report sync/async errors", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		const error = new Error("selection rejected"); let current = 0;
		await act(async () => {
			f.handle.update({ onChange: () => { current++; throw error; } });
			f.target.querySelector<HTMLElement>('[data-testid="practice-props-clear"]')!.click();
		});
		assert.equal(current, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.errors, [error]);
		await act(async () => { f.handle.update({ onChange: async () => { throw error; } }); });
		await click(f, "practice-props-clear");
		assert.deepEqual(f.errors, [error, error]);
		assert.equal(f.store.getSnapshot().length, 1);
	} finally { await f.dispose(); }
});

it("disabled controls neither fetch nor clear and disabling an open picker closes without losing selection", async () => {
	const f = await fixture({ value: ["a"], disabled: true });
	try {
		for (const id of ["practice-props-chip", "practice-props-clear"]) {
			assert.equal(f.target.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.disabled, true);
			await click(f, id);
		}
		assert.equal(f.requests.length, 0); assert.deepEqual(f.calls, []);
		await act(async () => { f.handle.update({ disabled: false }); });
		await click(f, "practice-props-chip"); assert.ok(overlay());
		const sourceSignal = f.requests.find((r) => r.url === "/api/graph/sources")!.init!.signal!;
		await act(async () => { f.handle.update({ disabled: true }); });
		assert.equal(overlay(), null); assert.equal(sourceSignal.aborted, true);
		assert.match(f.target.textContent!, /1 node selected/);
		await act(async () => { f.handle.update({ disabled: false }); });
		assert.equal(overlay(), null, "reenabling never silently reopens");
		await click(f, "practice-props-chip"); assert.ok(overlay());
	} finally { await f.dispose(); }
});

for (const ending of ["dispose", "widget abort", "navigation abort", "host unmount", "disable"] as const) {
	it(`${ending} aborts a pending graph read and stale completion cannot reopen`, async () => {
		const pending = deferred<Response>();
		const f = await fixture({ fetch: async () => pending.promise });
		try {
			await click(f, "practice-props-chip");
			const signal = f.requests[0]!.init!.signal!;
			assert.equal(signal.aborted, false);
			await act(async () => {
				if (ending === "dispose") f.handle.dispose();
				else if (ending === "widget abort") f.scope.abort();
				else if (ending === "navigation abort") f.lifetime.abort();
				else if (ending === "host unmount") await f.unmountHost();
				else f.handle.update({ disabled: true });
			});
			assert.equal(signal.aborted, true);
			await act(async () => { pending.resolve(Response.json(graph)); });
			assert.equal(overlay(), null); assert.equal(f.requests.length, 1); assert.deepEqual(f.errors, []);
			if (ending !== "disable" && ending !== "host unmount") assert.equal(f.target.textContent, "plugin-owned");
		} finally { await f.dispose(); }
	});
}

it("graph HTTP failures are observed and can be retried; missing host context reports without a body fallback", async () => {
	let failed = true;
	const f = await fixture({ fetch: async (url) => {
		if (failed) return Response.json({}, { status: 500 });
		return Response.json(url === "/api/graph" ? graph : directory);
	} });
	try {
		await click(f, "practice-props-chip"); assert.equal(overlay(), null); assert.equal(f.errors.length, 1);
		failed = false; await click(f, "practice-props-chip"); assert.ok(overlay());
	} finally { await f.dispose(); }
	const missing = await fixture({ missingRoot: true });
	try {
		await click(missing, "practice-props-chip");
		assert.equal(missing.errors.length, 1); assert.equal(overlay(), null); assert.equal(missing.requests.length, 0);
	} finally { await missing.dispose(); }
});

it("one Escape closes an actual foreground core dialog, not the picker beneath it", async () => {
	const f = await fixture();
	try {
		await click(f, "practice-props-chip");
		await act(async () => { f.showDialog(); });
		assert.ok(document.querySelector('[data-testid="delete-source-dialog"]'));
		await escape(f);
		assert.equal(f.dialogClosed, 1);
		assert.equal(document.querySelector('[data-testid="delete-source-dialog"]'), null);
		assert.ok(overlay(), "the foreground dialog must own the first Escape");
		await escape(f); assert.equal(overlay(), null);
	} finally { await f.dispose(); }
});

it("an actual host menu takes Escape before the picker and preserves controlled selection", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		await click(f, "practice-props-chip");
		await act(async () => {
			f.ui.openMenu(f.target, { items: [{ key: "item", label: "Item", onSelect() {} }] }, { signal: f.scope.signal });
		});
		assert.ok(document.querySelector("[data-lh-menu]"));
		await escape(f);
		assert.equal(document.querySelector("[data-lh-menu]"), null);
		assert.ok(overlay()); assert.match(f.target.textContent!, /1 node selected/);
		await escape(f); assert.equal(overlay(), null); assert.deepEqual(f.calls, []);
	} finally { await f.dispose(); }
});

it("source notify/resync refreshes only the open directory, never the cached graph", async () => {
	const f = await fixture();
	try {
		await click(f, "practice-props-chip");
		for (const notify of [() => f.notify("sources-changed"), () => f.notify("chats-changed"), () => f.resync()]) {
			await act(async () => { notify(); });
		}
		assert.equal(f.requests.filter((r) => r.url === "/api/graph/sources").length, 4);
		assert.equal(f.requests.filter((r) => r.url === "/api/graph").length, 1);
		await click(f, "chain-table-close");
		await act(async () => { f.notify("sources-changed"); f.notify("chats-changed"); f.resync(); });
		assert.equal(f.requests.length, 5);
	} finally { await f.dispose(); }
});

for (const stale of ["response", "error"] as const) it(`source reads abort on close and a stale ${stale} never publishes into a reopened picker`, async () => {
	const reads: ReturnType<typeof deferred<Response>>[] = [];
	const f = await fixture({ fetch: async (url) => {
		if (url === "/api/graph") return Response.json(graph);
		const read = deferred<Response>(); reads.push(read); return read.promise;
	} });
	try {
		await click(f, "practice-props-chip");
		const first = f.requests[1]!.init!.signal!;
		await click(f, "chain-table-close"); assert.equal(first.aborted, true);
		await click(f, "practice-props-chip");
		await act(async () => {
			reads[1]!.resolve(Response.json(directory));
			if (stale === "response") reads[0]!.resolve(Response.json({ ...directory, sources: [{ ...directory.sources[0], label: "Stale label" }] }));
			else reads[0]!.reject(new Error("stale source failure"));
		});
		assert.equal(overlay()!.textContent?.includes("Stale label"), false);
		assert.equal(overlay()!.querySelector('[role="alert"]'), null);
		assert.ok(overlay()!.querySelector('[data-testid="add-source-folder"]'));
		const second = f.requests[2]!.init!.signal!;
		await act(async () => { f.lifetime.abort(); });
		assert.equal(second.aborted, true); assert.equal(overlay(), null);
		assert.deepEqual(f.errors, []);
	} finally { await f.dispose(); }
});

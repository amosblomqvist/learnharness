import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { installModalDom } from "./modal-dom.ts";
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
const { InteractionLayersProvider, useInteractionLayers } = await import("../components/interaction-layers.tsx");
const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
const { useFieldCycle } = await import("../components/field-cycle.ts");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { DeleteSourceDialog } = await import("../components/delete-source-dialog.tsx");
const { SessionFind } = await import("../components/session-find.tsx");
const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
const { HostContentRootContext, HostRouteLifetimeContext, HostRouteLifetimeProvider } = await import("../components/host-content-root.tsx");
const { SessionSurfaceRegion, useSessionSurfaceBoundary } = await import("../components/plugin-session-surfaces.tsx");

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
async function fixture(options: { withSessionFind?: boolean; withKeyboard?: boolean; withSettings?: boolean; missingProvider?: boolean; missingPane?: boolean; value?: readonly string[]; disabled?: boolean; fetch?: typeof fetch } = {}) {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div><aside id='sidebar'></aside><main id='content' style='isolation:isolate'><button id='chrome'>Page chrome</button><div id='session-body'><div id='transcript'>Session text</div><input id='background-composer' /><div id='target'>plugin-owned</div><div id='second-target'></div></div></main></body></html>");
	const nativeSelect = dom.window.HTMLInputElement.prototype.select;
	dom.window.HTMLInputElement.prototype.select = function () {};
	const nativeClick = dom.window.HTMLInputElement.prototype.click;
	dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; nativeClick.call(this); };
	const requests: { url: string; init?: RequestInit }[] = [];
	const errors: unknown[] = [];
	const values = {
		React, window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1024, innerHeight: 800,
		requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
		fetch: (async (url, init) => {
			requests.push({ url: String(url), init });
			if (options.fetch) return options.fetch(url, init);
			if (url === "/api/settings") return Response.json({ settings: { version: 1, appearance: { background: "#141414" } } });
			assert.equal(init?.method, undefined, "opening/selecting must never mutate data");
			if (url === "/api/graph") return Response.json(graph);
			assert.equal(url, "/api/graph/sources");
			return Response.json(directory);
		}) as typeof fetch,
	};
	const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const cleanupModalDom = installModalDom(dom);
	const store = createPluginUiStore();
	const lifetime = new AbortController(); const scope = new AbortController(); const routeLifetime = new AbortController();
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
	let controller: ReturnType<typeof useInteractionLayers> | undefined;
	let openSettings: ReturnType<typeof useSettingsDialog>["open"] = () => {};
	let surfaceTarget: ReturnType<typeof useSessionSurfaceBoundary>;
	function Controls() {
		controller = useInteractionLayers();
		openSettings = useSettingsDialog().open;
		useFieldCycle(() => [document.querySelector<HTMLInputElement>("#background-composer")!]);
		const body = React.useRef(document.querySelector<HTMLDivElement>("#session-body"));
		surfaceTarget = useSessionSurfaceBoundary({ active: true, viewKey: "fixture", bodyRef: body });
		return <>{options.withKeyboard && <KeyboardShortcuts />}{createPortal(<SessionSurfaceRegion target={surfaceTarget} />, body.current!)}</>;
	}
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	function Host() {
		const [dialog, setDialog] = useState(false);
		showDialog = () => setDialog(true);
		const body = <>
				<PluginUiHost store={store} />
				{!options.missingProvider && <Controls />}
				{options.withSessionFind && <SessionFind scopeRef={{ current: document.querySelector<HTMLDivElement>("#transcript") }} scrollContextRef={{ current: null }} />}
				<DeleteSourceDialog open={dialog} sources={[]} folders={[]} onDelete={async () => {}} onClose={() => { dialogClosed++; setDialog(false); }} />
			</>;
		const settingsBody = options.withSettings ? <SettingsDialogProvider>{body}</SettingsDialogProvider> : body;
		return <AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><HostContentRootContext.Provider value={options.missingPane ? null : content}><HostRouteLifetimeContext.Provider value={{ pathname: "/fixture", signal: routeLifetime.signal }}>{options.missingProvider ? settingsBody : <InteractionLayersProvider>{settingsBody}</InteractionLayersProvider>}</HostRouteLifetimeContext.Provider></HostContentRootContext.Provider></ServerEventsProvider></AppRouterContext.Provider>;
	}
	await act(async () => {
		root.render(<Host />);
		handle = ui.mountKnowledgePicker(target, { value: options.value ?? [], disabled: options.disabled, onChange: (ids) => { calls.push([...ids]); } }, { signal: scope.signal });
	});
	return {
		dom, store, ui, lifetime, scope, routeLifetime, handle, target, content, requests, errors, calls, showDialog,
		get surfaceTarget() { assert.ok(surfaceTarget); return surfaceTarget; },
		get controller() { assert.ok(controller); return controller; },
		async openSettings(section = "appearance") { await act(async () => { openSettings(section); }); },
		notify(name: string) { notifications.get(name)?.("{}"); }, resync() { resync(); },
		get dialogClosed() { return dialogClosed; },
		async dispose() {
			await act(async () => { lifetime.abort(); root.unmount(); });
			await new Promise(resolve => setTimeout(resolve, 0));
			cleanupModalDom();
			dom.window.HTMLInputElement.prototype.click = nativeClick;
			dom.window.HTMLInputElement.prototype.select = nativeSelect;
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
			}
		},
		async unmountHost() { await act(async () => root.unmount()); },
	};
}
async function click(f: Fixture, testid: string, within: ParentNode = document) {
	const target = within.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
	assert.ok(target, testid);
	await act(async () => {
		if (target.matches("button:not([disabled])")) target.focus();
		target.dispatchEvent(new f.dom.window.Event("click", { bubbles: true }));
	});
	await new Promise(resolve => setTimeout(resolve, 0));
}
async function escape(f: Fixture, target: EventTarget = document) {
	const event = new f.dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: "Escape" });
	await act(async () => { target.dispatchEvent(event); });
	await new Promise(resolve => setTimeout(resolve, 0));
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

it("a missing interaction provider reports normally without private ownership fallback", async () => {
	const f = await fixture({ missingProvider: true });
	try {
		await click(f, "practice-props-chip"); assert.equal(overlay(), null); assert.equal(f.requests.length, 0); assert.equal(f.errors.length, 1);
	} finally { await f.dispose(); }
});

it("lazily loads the real Chains interface as one nonmodal main-pane view, preserving its source controls", async () => {
	const f = await fixture();
	try {
		assert.equal(f.requests.length, 0);
		assert.equal(f.target.querySelector('[data-testid="practice-props-chip"]')?.textContent, "Pick nodes");
		await click(f, "practice-props-chip");
		assert.deepEqual(f.requests.map((r) => r.url), ["/api/graph", "/api/graph/sources"]);
		const pane = overlay()!.closest<HTMLElement>('[data-plugin-knowledge-picker-pane]'); assert.ok(pane);
		assert.equal(pane.parentElement, f.content);
		assert.equal(overlay()!.closest('[role="dialog"]'), null);
		assert.equal(f.controller.getSnapshot().filter(layer => layer.kind === "modal").length, 0);
		assert.equal(f.controller.getSnapshot().filter(layer => layer.kind === "view").length, 1, "one physical picker surface has one interaction owner");
		assert.equal(document.querySelector("#sidebar")!.getAttribute("aria-hidden"), null);
		assert.equal(document.querySelector("#sidebar")!.closest("[inert]"), null);
		assert.equal(document.body.style.overflow ?? "", "");
		assert.equal(f.controller.isElementEligible(document.querySelector("#chrome")), true);
		assert.equal(document.activeElement, document.querySelector('[data-testid="chain-table-search"]'));
		assert.equal((document.querySelector("#sidebar") as HTMLElement).style.display, "");
		assert.match(overlay()!.className, /absolute inset-0/);
		assert.equal(document.querySelector("#sidebar")!.children.length, 0);
		assert.ok(overlay()!.querySelector('[data-testid="chain-table"]'));
		assert.equal(overlay()!.querySelector('[aria-label="Open sidebar"]'), null);
		assert.ok(overlay()!.querySelector('header.lh-native-window-clearance'));
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
				else if (ending === "navigation abort") f.routeLifetime.abort();
				else if (ending === "host unmount") await f.unmountHost();
				else f.handle.update({ disabled: true });
			});
			assert.equal(signal.aborted, true);
			await act(async () => { pending.resolve(Response.json(graph)); });
			assert.equal(overlay(), null); assert.equal(f.requests.length, 1); assert.deepEqual(f.errors, []);
			if (ending !== "disable" && ending !== "host unmount" && ending !== "navigation abort") assert.equal(f.target.textContent, "plugin-owned");
		} finally { await f.dispose(); }
	});
}

it("graph HTTP failures are observed and can be retried", async () => {
	let failed = true;
	const f = await fixture({ fetch: async (url) => {
		if (failed) return Response.json({}, { status: 500 });
		return Response.json(url === "/api/graph" ? graph : directory);
	} });
	try {
		await click(f, "practice-props-chip"); assert.equal(overlay(), null); assert.equal(f.errors.length, 1);
		failed = false; await click(f, "practice-props-chip"); assert.ok(overlay());
	} finally { await f.dispose(); }
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
			f.ui.openMenu(document.querySelector<HTMLElement>('[data-testid="chain-table-close"]')!, { items: [{ key: "item", label: "Item", onSelect() {} }] }, { signal: f.scope.signal });
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

async function publicOrigin(f: Fixture) {
	let mounts = 0, cleanups = 0;
	const input = document.createElement("input"); input.value = "parent draft";
	const target = document.createElement("div");
	let picker!: PluginWidgetHandle<PluginKnowledgePickerProps>;
	let dialog!: ReturnType<typeof f.ui.openDialog>;
	const selections: string[][] = [];
	await act(async () => {
		dialog = f.ui.openDialog({ title: "Origin", content(container, signal) {
			mounts++; container.append(input, target);
			picker = f.ui.mountKnowledgePicker(target, { value: ["a"], onChange(ids) { selections.push([...ids]); picker.update({ value: ids }); } }, { signal });
			return () => { cleanups++; picker.dispose(); };
		} }, { signal: f.scope.signal });
	});
	return { input, target, picker, dialog, selections, get mounts() { return mounts; }, get cleanups() { return cleanups; } };
}

for (const action of ["Done", "X", "Escape"] as const) it(`a public dialog origin stays painted/mounted and regains its own state/focus after picker ${action}`, async () => {
	const f = await fixture();
	try {
		const origin = await publicOrigin(f);
		const parent = origin.input.closest<HTMLElement>('[role="dialog"]')!;
		const frame = origin.input.closest<HTMLElement>("[data-plugin-ui-dialog]")!;
		origin.input.value = "edited parent draft";
		await click(f, "practice-props-chip", origin.target);
		assert.ok(overlay()); assert.equal(origin.mounts, 1); assert.equal(origin.cleanups, 0);
		assert.equal(parent.isConnected, true); assert.equal(parent.hidden, false); assert.notEqual(parent.style.display, "none");
		assert.equal(frame.hidden, false); assert.notEqual(frame.style.display, "none");
		assert.equal(parent.hasAttribute("inert"), true); assert.equal(parent.getAttribute("aria-hidden"), "true");
		assert.equal(f.controller.getSnapshot().length, 2, "parent modal + picker modal, no duplicate table view");
		if (action === "Done") await click(f, "chain-practice-done");
		else if (action === "X") await click(f, "chain-table-close");
		else await escape(f);
		assert.equal(overlay(), null); assert.equal(origin.mounts, 1); assert.equal(origin.cleanups, 0);
		assert.equal(origin.input.isConnected, true); assert.equal(origin.input.value, "edited parent draft");
		assert.equal(parent.hasAttribute("inert"), false); assert.notEqual(parent.getAttribute("aria-hidden"), "true");
		assert.equal(document.activeElement, origin.target.querySelector('[data-testid="practice-props-chip"]'));
		assert.match(origin.target.textContent!, /1 node selected/); assert.equal(origin.selections.length, 0);
	} finally { await f.dispose(); }
});

for (const phase of ["pending", "open"] as const) it(`a global modal's ${phase} picker survives unrelated background route expiry, but not actual modal owner retirement`, async () => {
	const read = deferred<Response>();
	const f = await fixture(phase === "pending" ? { fetch: async url => url === "/api/graph" ? read.promise : Response.json(directory) } : {});
	try {
		const origin = await publicOrigin(f);
		await click(f, "practice-props-chip", origin.target);
		const signal = f.requests.find(request => request.url === "/api/graph")!.init!.signal!;
		await act(async () => { f.routeLifetime.abort(); });
		assert.equal(signal.aborted, false, "the background page is not the modal's lifetime owner");
		if (phase === "pending") await act(async () => { read.resolve(Response.json(graph)); });
		assert.ok(overlay()); assert.ok(overlay()!.closest('[role="dialog"]'));
		assert.equal(f.controller.getSnapshot().filter(layer => layer.kind === "modal").length, 2);
		await act(async () => { origin.dialog.dispose(); });
		assert.equal(overlay(), null); assert.equal(origin.cleanups, 1);
	} finally { await f.dispose(); }
});

it("invocation ownership walks a popup's actual modal ancestor instead of treating its portal as a page", async () => {
	const f = await fixture();
	try {
		const origin = await publicOrigin(f);
		let menu!: ReturnType<typeof f.ui.openMenu>;
		await act(async () => { menu = f.ui.openMenu(origin.input, { items: [{ key: "row", label: "Row", onSelect() {} }] }, { signal: f.scope.signal }); });
		const target = document.createElement("div"); document.querySelector("[data-lh-menu]")!.append(target);
		await act(async () => { f.ui.mountKnowledgePicker(target, { value: [], onChange() {} }, { signal: f.scope.signal }); });
		await click(f, "practice-props-chip", target);
		assert.ok(overlay()!.closest('[role="dialog"]'));
		assert.equal(document.querySelector("[data-plugin-knowledge-picker-pane]"), null);
		assert.equal(f.controller.getSnapshot().filter(layer => layer.kind === "modal").length, 2);
		await act(async () => { f.routeLifetime.abort(); }); assert.ok(overlay());
		await act(async () => { menu.dispose(); }); assert.equal(overlay(), null, "exact popup owner retirement expires its selector");
	} finally { await f.dispose(); }
});

it("a newer public dialog owns Escape/focus without hiding or destroying the picker underneath", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		await click(f, "practice-props-chip"); const picker = overlay()!;
		const input = document.createElement("input"); input.value = "new dialog draft";
		await act(async () => { f.ui.openDialog({ title: "Later", content: input }, { signal: f.scope.signal }); });
		const parent = picker.closest<HTMLElement>('[data-plugin-knowledge-picker-pane]')!;
		assert.equal(parent.hidden, false); assert.notEqual(parent.style.display, "none"); assert.ok(parent.closest('[aria-hidden="true"]'));
		await escape(f); assert.equal(input.isConnected, false); assert.equal(overlay(), picker);
		assert.equal(parent.contains(document.activeElement), true, "closing a later dialog resumes focus within the picker");
		await escape(f); assert.equal(overlay(), null);
	} finally { await f.dispose(); }
});

it("disposing a public origin while its picker is open cleans up owned content without resurrection", async () => {
	const f = await fixture();
	try {
		const origin = await publicOrigin(f); await click(f, "practice-props-chip", origin.target);
		assert.ok(overlay());
		await act(async () => { origin.dialog.dispose(); });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(overlay(), null); assert.equal(origin.input.isConnected, false);
		assert.equal(origin.cleanups, 1); assert.equal(f.controller.getSnapshot().length, 0);
	} finally { await f.dispose(); }
});

it("Tab retains native-default prevention and never cycles into covered composer fields", async () => {
	const f = await fixture({ withKeyboard: true });
	try {
		await click(f, "practice-props-chip");
		const search = document.querySelector<HTMLInputElement>('[data-testid="chain-table-search"]')!; search.focus();
		for (const shiftKey of [false, true]) {
			const event = new f.dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Tab", shiftKey });
			await act(async () => { search.dispatchEvent(event); });
			assert.equal(event.defaultPrevented, true); assert.equal(document.activeElement, search);
		}
		await click(f, "chain-table-close");
		await act(async () => { window.dispatchEvent(new f.dom.window.CustomEvent("lh:kbd-cycle-fields")); });
		assert.equal(document.activeElement, document.querySelector("#background-composer"), "the existing explicit binding still works after dismissal");
	} finally { await f.dispose(); }
});

it("a newer modal revokes an outstanding graph read and its late response never promotes", async () => {
	const read = deferred<Response>();
	const f = await fixture({ fetch: async url => url === "/api/graph" ? read.promise : Response.json(directory) });
	try {
		await click(f, "practice-props-chip");
		const signal = f.requests[0]!.init!.signal!;
		const input = document.createElement("input");
		await act(async () => { f.ui.openDialog({ title: "Later", content: input }, { signal: f.scope.signal }); });
		assert.equal(signal.aborted, true);
		await act(async () => { read.resolve(Response.json(graph)); });
		assert.equal(overlay(), null); assert.equal(input.isConnected, true); assert.deepEqual(f.errors, []);
		await escape(f); assert.equal(overlay(), null, "closing later UI never resumes a revoked request");
	} finally { await f.dispose(); }
});

for (const stale of ["response", "error"] as const) it(`a newer pending picker aborts the old read, ignores its late ${stale}, and survives old disposal`, async () => {
	const reads = [deferred<Response>(), deferred<Response>()]; let nextRead = 0;
	const f = await fixture({ value: ["a"], fetch: async url => url === "/api/graph" ? reads[nextRead++]!.promise : Response.json(directory) });
	try {
		const secondTarget = document.querySelector<HTMLElement>("#second-target")!;
		let second!: PluginWidgetHandle<PluginKnowledgePickerProps>;
		await act(async () => { second = f.ui.mountKnowledgePicker(secondTarget, { value: ["b"], onChange() {} }, { signal: f.scope.signal }); });
		await click(f, "practice-props-chip", f.target); const first = f.requests[0]!.init!.signal!;
		await click(f, "practice-props-chip", secondTarget); assert.equal(first.aborted, true);
		await act(async () => { reads[1]!.resolve(Response.json(graph)); }); assert.ok(overlay());
		assert.equal(document.querySelectorAll('[data-testid="chain-table-overlay"]').length, 1);
		await act(async () => {
			f.handle.dispose();
			if (stale === "response") reads[0]!.resolve(Response.json(graph)); else reads[0]!.reject(new Error("late read failure"));
		});
		assert.ok(overlay()); assert.deepEqual(f.errors, []);
		await click(f, "chain-table-close"); assert.equal(overlay(), null);
		assert.match(secondTarget.textContent!, /1 node selected/);
		await act(async () => { second.dispose(); });
	} finally { await f.dispose(); }
});

it("cached selectors replace the exact retiring registration once, retaining IDs and ignoring stale cleanup", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		const secondTarget = document.querySelector<HTMLElement>("#second-target")!;
		let second!: PluginWidgetHandle<PluginKnowledgePickerProps>;
		await act(async () => { second = f.ui.mountKnowledgePicker(secondTarget, { value: ["b"], onChange() {} }, { signal: f.scope.signal }); });
		await click(f, "practice-props-chip", secondTarget); await click(f, "chain-table-close");
		await click(f, "practice-props-chip", f.target);
		await click(f, "practice-props-chip", secondTarget);
		assert.equal(document.querySelectorAll('[data-testid="chain-table-overlay"]').length, 1);
		assert.equal(f.controller.getSnapshot().filter(layer => layer.kind === "view").length, 1);
		assert.match(f.target.textContent!, /1 node selected/); assert.match(secondTarget.textContent!, /1 node selected/);
		await act(async () => { f.handle.dispose(); }); assert.ok(overlay());
		await click(f, "chain-table-close"); assert.equal(overlay(), null);
		await click(f, "practice-props-chip", secondTarget); assert.ok(overlay());
		assert.equal(f.requests.filter(request => request.url === "/api/graph").length, 2);
		await act(async () => { second.dispose(); });
	} finally { await f.dispose(); }
});

it("accepted source writes outlive picker disposal and do not mutate selection or resurrect its modal", async () => {
	const write = deferred<Response>(); let accepted = false;
	const f = await fixture({ value: ["a"], fetch: async (url, init) => {
		if (init?.method === "POST") { accepted = true; assert.equal(init.signal, undefined); return write.promise; }
		return Response.json(url === "/api/graph" ? graph : directory);
	} });
	try {
		await click(f, "practice-props-chip");
		const event = new f.dom.window.Event("drop", { bubbles: true, cancelable: true });
		Object.assign(event, { dataTransfer: { getData: () => JSON.stringify({ kind: "source", id: "chat" }) } });
		await act(async () => { document.querySelector('[data-testid="source-root-drop"]')!.dispatchEvent(event); });
		assert.equal(accepted, true);
		await act(async () => { f.handle.dispose(); }); assert.equal(overlay(), null);
		await act(async () => { write.resolve(Response.json(directory)); });
		assert.equal(overlay(), null); assert.deepEqual(f.calls, []); assert.deepEqual(f.errors, []);
	} finally { await f.dispose(); }
});

for (const action of ["Done", "X", "Escape"] as const) it(`Settings origin stays painted with state and scroll intact after picker ${action}`, async () => {
	const f = await fixture({ withSettings: true });
	try {
		await f.openSettings();
		const frame = document.querySelector<HTMLElement>('[data-testid="settings-dialog"]')!;
		const boundary = frame.closest<HTMLElement>('[role="dialog"]')!;
		const content = document.querySelector<HTMLElement>('[data-testid="settings-content"]')!;
		const background = document.querySelector('[data-testid="input-background"]'); assert.ok(background);
		content.scrollTop = 53;
		const custom = document.createElement("div"), input = document.createElement("input");
		input.value = "custom settings draft"; frame.append(custom); custom.append(input);
		let handle!: PluginWidgetHandle<PluginKnowledgePickerProps>;
		await act(async () => { handle = f.ui.mountKnowledgePicker(custom, { value: ["a"], onChange(ids) { handle.update({ value: ids }); } }, { signal: f.scope.signal }); });
		await click(f, "practice-props-chip", custom);
		assert.ok(overlay()); assert.equal(boundary.hidden, false); assert.notEqual(boundary.style.display, "none");
		assert.equal(frame.hidden, false); assert.notEqual(frame.style.display, "none"); assert.equal(boundary.hasAttribute("inert"), true);
		assert.equal(document.querySelector('[data-testid="input-background"]'), background);
		if (action === "Done") await click(f, "chain-practice-done");
		else if (action === "X") await click(f, "chain-table-close");
		else await escape(f);
		assert.equal(overlay(), null); assert.equal(document.querySelector('[data-testid="settings-dialog"]'), frame);
		assert.equal(document.querySelector('[data-testid="input-background"]'), background);
		assert.equal(content.scrollTop, 53); assert.equal(input.value, "custom settings draft");
		assert.equal(document.activeElement, custom.querySelector('[data-testid="practice-props-chip"]'));
		assert.equal(boundary.hasAttribute("inert"), false);
		await act(async () => { handle.dispose(); }); custom.remove();
	} finally { await f.dispose(); }
});

it("fresh Settings nests above an active picker and closing it returns focus into the still-active picker", async () => {
	const f = await fixture({ withSettings: true });
	try {
		await click(f, "practice-props-chip"); const picker = overlay()!;
		await f.openSettings(); assert.ok(document.querySelector('[data-testid="settings-dialog"]'));
		const boundary = picker.closest<HTMLElement>('[data-plugin-knowledge-picker-pane]')!;
		assert.equal(boundary.isConnected, true); assert.equal(boundary.hidden, false); assert.notEqual(boundary.style.display, "none");
		assert.ok(boundary.closest('[aria-hidden="true"]'));
		await escape(f); assert.equal(document.querySelector('[data-testid="settings-dialog"]'), null);
		assert.equal(overlay(), picker); assert.equal(boundary.contains(document.activeElement), true);
		await escape(f); assert.equal(overlay(), null);
	} finally { await f.dispose(); }
});

it("missing trusted pane fails closed without a viewport fallback", async () => {
	const f = await fixture({ missingPane: true });
	try {
		await click(f, "practice-props-chip");
		assert.equal(overlay(), null); assert.equal(f.requests.length, 0);
		assert.equal(f.errors.length, 1); assert.equal(f.controller.getSnapshot().length, 0);
	} finally { await f.dispose(); }
});

it("route expiry closes an active pane picker without disposing its retained widget or selection", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		await click(f, "practice-props-chip");
		const sourceRead = f.requests.find(request => request.url === "/api/graph/sources")!.init!.signal!;
		await act(async () => { f.routeLifetime.abort(); });
		assert.equal(overlay(), null); assert.equal(sourceRead.aborted, true);
		assert.match(f.target.textContent!, /1 node selected/);
		await click(f, "practice-props-chip");
		assert.equal(overlay(), null); assert.equal(f.requests.length, 2, "expired source never falls back to a body modal");
	} finally { await f.dispose(); }
});

for (const phase of ["pending", "open"] as const) it(`exact invocation owner retirement expires a ${phase} picker even when its layer ID is immediately reused`, async () => {
	const read = deferred<Response>();
	const f = await fixture(phase === "pending" ? { fetch: async () => read.promise } : {});
	try {
		const body = document.querySelector<HTMLElement>("#session-body")!;
		let unregister!: () => void;
		await act(async () => { unregister = f.controller.register({ id: "reused-source", kind: "view", rootRef: { current: body } }); });
		await click(f, "practice-props-chip");
		const signal = f.requests[0]!.init!.signal!;
		await act(async () => {
			unregister();
			unregister = f.controller.register({ id: "reused-source", kind: "view", rootRef: { current: body } });
		});
		assert.equal(overlay(), null);
		if (phase === "pending") {
			assert.equal(signal.aborted, true);
			await act(async () => { read.resolve(Response.json(graph)); });
			assert.equal(overlay(), null);
		}
		await act(async () => unregister());
	} finally { await f.dispose(); }
});

it("session surfaces, their popup hosts, and pane pickers share causal local paint ranks while global dialogs stay outside", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		const nestedTarget = document.createElement("div");
		let older!: ReturnType<typeof f.ui.openSurface>;
		await act(async () => {
			older = f.ui.openSurface(f.surfaceTarget, { title: "Older surface", content: nestedTarget }, { signal: f.scope.signal });
			f.ui.mountKnowledgePicker(nestedTarget, { value: ["a"], onChange() {} }, { signal: f.scope.signal });
		});
		const olderLayer = f.controller.getTopLayer()!;
		const olderRoot = olderLayer.rootRef.current!;
		const olderFrame = olderRoot.querySelector<HTMLElement>("[data-plugin-session-surface-frame]")!;
		const olderPopup = f.controller.getPortalContainer(nestedTarget)!;
		assert.ok(olderPopup.hasAttribute("data-interaction-popup-host"));
		const passive = document.createElement("div"); passive.textContent = "Older owned popup"; passive.style.zIndex = "9999"; olderPopup.append(passive);
		await click(f, "practice-props-chip", nestedTarget);
		const picker = document.querySelector<HTMLElement>("[data-plugin-knowledge-picker-pane]")!;
		assert.ok(picker); assert.equal(picker.parentElement, f.content);
		assert.equal(f.controller.getTopLayer()!.rootRef.current, picker);
		assert.ok(Number(picker.style.zIndex) > Number(olderPopup.style.zIndex));
		assert.equal(Number(olderPopup.style.zIndex), Number(olderFrame.style.zIndex));
		assert.equal(olderRoot.isConnected, true, "covering preserves the source DOM");
		assert.equal(f.controller.getLayer(olderLayer.id), olderLayer, "covering preserves the exact invocation owner registration; inertness is not lifetime expiry");
		assert.equal(f.controller.getPortalContainer(picker.querySelector("button")), picker.querySelector("[data-interaction-popup-host]"));
		const input = document.createElement("input");
		let newer!: ReturnType<typeof f.ui.openSurface>;
		await act(async () => { newer = f.ui.openSurface(f.surfaceTarget, { title: "Newer surface", content: input }, { signal: f.scope.signal }); });
		const newerLayer = f.controller.getTopLayer()!;
		const newerFrame = newerLayer.rootRef.current!.querySelector<HTMLElement>("[data-plugin-session-surface-frame]")!;
		assert.ok(Number(newerFrame.style.zIndex) > Number(picker.style.zIndex));
		assert.equal(document.querySelector("[data-plugin-knowledge-picker-pane]"), picker, "covering is not expiry");
		assert.equal(olderRoot.hasAttribute("inert"), true, "session-region coverage policy remains intact");
		assert.doesNotMatch(document.querySelector("[data-session-surface-region]")!.className, /\bz-40\b/);
		await act(async () => { f.ui.openDialog({ title: "Global dialog", content: document.createElement("input") }, { signal: f.scope.signal }); });
		const modal = f.controller.getActiveModal()!;
		assert.equal(f.controller.getTopLayer(), modal);
		assert.equal(modal.rootRef.current!.parentElement, document.body);
		assert.equal(f.content.style.isolation, "isolate"); assert.equal(f.content.contains(modal.rootRef.current), false);
		await escape(f);
		await act(async () => { newer.dispose(); });
		assert.equal(f.controller.getTopLayer()!.rootRef.current, picker);
		await click(f, "chain-practice-done");
		assert.equal(overlay(), null); assert.equal(olderRoot.isConnected, true);
		await act(async () => { older.dispose(); });
	} finally { await f.dispose(); }
});

it("pane view does not trap sidebar focus or mutate sidebar attributes, and Done has no practice glyph", async () => {
	const f = await fixture({ value: ["a"] });
	try {
		const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
		sidebar.setAttribute("data-sidebar-state", "unchanged");
		const button = document.createElement("button"); sidebar.append(button);
		const before = sidebar.outerHTML;
		await click(f, "practice-props-chip");
		assert.equal(document.querySelector('[data-testid="chain-practice-done"] svg'), null);
		button.focus(); await Promise.resolve();
		assert.equal(document.activeElement, button);
		assert.equal(sidebar.outerHTML, before);
	} finally { await f.dispose(); }
});

it("picker-only native clearance tracks real pane position through resize, scroll, and zoom without observer loops", async () => {
	const f = await fixture();
	const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	const prototype = f.dom.window.HTMLElement.prototype;
	const originalRect = prototype.getBoundingClientRect;
	let left = 0, resize = () => {}, zoom = () => {};
	Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class {
		constructor(callback: () => void) { resize = callback; }
		observe() {} disconnect() {}
	} });
	prototype.getBoundingClientRect = function () {
		return this.matches("header.lh-native-window-clearance") ? { left } as DOMRect : originalRect.call(this);
	};
	window.lh = { platform: "darwin", expandWindow() {}, onZoom(callback) { zoom = () => callback(1.5); return () => {}; } };
	try {
		document.documentElement.classList.add("lh-electron"); document.documentElement.dataset.lhPlatform = "darwin";
		document.documentElement.style.setProperty("--lh-zoom", "1.5");
		await click(f, "practice-props-chip");
		const header = overlay()!.querySelector<HTMLElement>("header")!;
		assert.equal(header.style.getPropertyValue("--lh-header-left"), "0px");
		left = 288; resize(); assert.equal(header.style.getPropertyValue("--lh-header-left"), "288px");
		header.style.setProperty("--lh-header-left", "sentinel");
		resize(); resize(); assert.equal(header.style.getPropertyValue("--lh-header-left"), "sentinel", "unchanged observer notifications never write another style");
		left = 144; window.dispatchEvent(new f.dom.window.Event("resize"));
		assert.equal(header.style.getPropertyValue("--lh-header-left"), "144px");
		left = 72; zoom(); assert.equal(header.style.getPropertyValue("--lh-header-left"), "72px");
		left = 0; window.dispatchEvent(new f.dom.window.Event("scroll"));
		assert.equal(header.style.getPropertyValue("--lh-header-left"), "0px");
		assert.equal(header.querySelector('[aria-label="Open sidebar"]'), null);
		const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.match(css, /\[data-lh-platform="darwin"\] \.lh-native-window-clearance\s*\{\s*padding-left: calc\(0\.75rem \+ max\(0px, calc\(92px \/ var\(--lh-zoom\) - var\(--lh-header-left, 0px\)\)\)\);/);
		assert.match(css, /--lh-wco-right: max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/);
		assert.match(header.className, /lh-wco-gutter/, "Windows/Linux still use the existing CSS-coordinate right gutter");
	} finally {
		prototype.getBoundingClientRect = originalRect;
		if (originalObserver) Object.defineProperty(globalThis, "ResizeObserver", originalObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
		await f.dispose();
	}
});

it("host route lifetimes rotate on departure/re-entry and survive StrictMode's effect replay", async () => {
	const f = await fixture();
	const mount = document.createElement("div"); f.content.append(mount);
	const root = createRoot(mount);
	let current: React.ContextType<typeof HostRouteLifetimeContext> = null;
	function Capture() { current = React.useContext(HostRouteLifetimeContext); return null; }
	const render = async (pathname: string) => { await act(async () => { root.render(<React.StrictMode><HostRouteLifetimeProvider pathname={pathname}><Capture /></HostRouteLifetimeProvider></React.StrictMode>); }); };
	try {
		await render("/a"); const first = current!; assert.equal(first.signal.aborted, false);
		await render("/b"); assert.equal(first.signal.aborted, true); const second = current!;
		assert.equal(second.signal.aborted, false);
		await render("/a"); assert.equal(second.signal.aborted, true); assert.notEqual(current!.signal, first.signal);
		assert.equal(current!.signal.aborted, false);
	} finally { await act(async () => { root.unmount(); }); await f.dispose(); }
});

it("successful explicit Settings opening revokes a pending picker instead of letting its graph completion promote", async () => {
	const read = deferred<Response>();
	const f = await fixture({ withSettings: true, fetch: async url => url === "/api/graph" ? read.promise : Response.json({ settings: { version: 1 } }) });
	try {
		await click(f, "practice-props-chip"); const signal = f.requests.find(request => request.url === "/api/graph")!.init!.signal!;
		await f.openSettings(); assert.equal(signal.aborted, true);
		await act(async () => { read.resolve(Response.json(graph)); });
		assert.equal(overlay(), null); assert.ok(document.querySelector('[data-testid="settings-dialog"]'));
		await escape(f); assert.equal(overlay(), null); assert.deepEqual(f.errors, []);
	} finally { await f.dispose(); }
});

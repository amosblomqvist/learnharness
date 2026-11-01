import React, { act } from "react";
import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import type { PluginDialogProps, PluginKnowledgePickerProps, PluginWidgetHandle } from "../src/core/plugin-ui.ts";
import type { PluginFrontendModule, PluginInfo } from "../src/core/index.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-picker-foreground-ui-"));
const environment = { ...process.env };
process.env.HOME = path.join(scratch, "home"); process.env.LH_DATA_DIR = path.join(scratch, "data"); process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.mkdirSync(process.env.HOME, { recursive: true }); fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => { process.env = environment; fs.rmSync(scratch, { recursive: true, force: true }); });
const { createPluginWindowOwner, PluginsProvider, PluginWidgets } = await import("../components/plugins.tsx");
const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
const { HostContentRootContext } = await import("../components/host-content-root.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { KnowledgePickerForegroundProvider } = await import("../components/knowledge-picker-foreground.tsx");
const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
const graph = { propositions: [{ id: "a", name: "Node A", statement: "Statement A", aliases: [], provenance: [{ chatId: "chat", messageId: "message" }], createdAt: "2026-10-01" }], chains: [], sessions: { chat: "Lesson" }, fileSources: {} };
const directory = { organization: { version: 1, folders: [], placements: {} }, sources: [{ id: "chat", kind: "chat", label: "Lesson", createdAt: "2026-10-01" }] };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(options: { fetchGraph?: (init?: RequestInit) => Promise<Response>; write?: (init?: RequestInit) => Promise<Response> } = {}) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div><aside><button id='launcher'>Launcher</button></aside><main id='content'><div id='main-picker'></div><div id='second-picker'></div></main></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	const originalFocus = dom.window.HTMLElement.prototype.focus;
	const originalSelect = dom.window.HTMLInputElement.prototype.select;
	const originalClick = dom.window.HTMLInputElement.prototype.click;
	dom.window.HTMLElement.prototype.focus = function () { active = this; };
	dom.window.HTMLInputElement.prototype.select = function () {};
	dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; originalClick.call(this); };
	const requests: { url: string; init?: RequestInit }[] = [];
	const errors: unknown[] = [];
	const storage = new Map<string, string>();
	const values = {
		React, window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1200, innerHeight: 900,
		requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, __lhPluginWindow: undefined,
		localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
		fetch: (async (url, init) => {
			requests.push({ url: String(url), init });
			if (url === "/api/graph") return options.fetchGraph?.(init) ?? Response.json(graph);
			if (url === "/api/graph/sources") return init?.method === "POST" ? options.write?.(init) ?? Response.json(directory) : Response.json(directory);
			assert.equal(url, "/api/settings"); return Response.json({ settings: { version: 1 } });
		}) as typeof fetch,
	};
	const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const lifetime = new AbortController(); const scope = new AbortController();
	let settingsMounts = 0, settingsCleanups = 0, dialogMounts = 0, dialogCleanups = 0;
	let settingsHandle!: PluginWidgetHandle<PluginKnowledgePickerProps>;
	let dialogPicker!: PluginWidgetHandle<PluginKnowledgePickerProps>;
	const selections = new Map<string, readonly string[]>();
	const pluginModule: PluginFrontendModule = { activate(ctx) {
		ctx.registerSettings((container, signal) => {
			settingsMounts++;
			const input = document.createElement("input"); input.dataset.testid = "settings-owned-input"; input.value = "settings state"; container.append(input);
			settingsHandle = ctx.ui.mountKnowledgePicker(container, { value: ["a"], onChange: (value) => { selections.set("settings", value); settingsHandle.update({ value }); } }, { signal });
			return () => { settingsCleanups++; };
		});
	} };
	const info: PluginInfo = { id: "fixture", enabled: true, status: "active", revision: "one", manifest: { apiVersion: 1, id: "fixture", name: "Fixture", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js" } };
	const owner = createPluginWindowOwner({ fetch: async () => Response.json({ plugins: [info], directory: "/fixture" }), importModule: async () => pluginModule, pathname: () => "/", navigate() {} });
	window.__lhPluginWindow = owner;
	const ui = owner.uiStore.createUi({ signal: lifetime.signal, onError: (error) => errors.push(error) });
	const content = document.querySelector<HTMLElement>("#content")!;
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	let openSettings!: (section?: string) => void;
	function Controls() { openSettings = useSettingsDialog().open; return <KeyboardShortcuts />; }
	const root = createRoot(document.querySelector("#root")!);
	let main!: PluginWidgetHandle<PluginKnowledgePickerProps>;
	let second!: PluginWidgetHandle<PluginKnowledgePickerProps>;
	await act(async () => {
		root.render(<AppRouterContext.Provider value={router}><ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}><PluginsProvider>
			<HostContentRootContext.Provider value={content}><KnowledgePickerForegroundProvider><SettingsDialogProvider>
				<Controls /><PluginWidgets />
			</SettingsDialogProvider></KnowledgePickerForegroundProvider></HostContentRootContext.Provider>
		</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider>);
		main = ui.mountKnowledgePicker(document.querySelector("#main-picker")!, { value: ["a"], onChange: (value) => { selections.set("main", value); main.update({ value }); } }, { signal: scope.signal });
		second = ui.mountKnowledgePicker(document.querySelector("#second-picker")!, { value: ["outside"], onChange: (value) => { selections.set("second", value); second.update({ value }); } }, { signal: scope.signal });
	});
	const f = {
		dom, requests, errors, content, ui, main, second, lifetime, scope, selections,
		openSettings(section = "plugin:fixture") { openSettings(section); },
		get settingsHandle() { return settingsHandle; }, get dialogPicker() { return dialogPicker; },
		get settingsMounts() { return settingsMounts; }, get settingsCleanups() { return settingsCleanups; },
		get dialogMounts() { return dialogMounts; }, get dialogCleanups() { return dialogCleanups; },
		openDialog(title = "Origin") {
			return ui.openDialog({ title, content: (container, signal) => {
				dialogMounts++;
				const input = document.createElement("input"); input.dataset.testid = "dialog-owned-input"; input.value = "dialog state"; container.append(input);
				dialogPicker = ui.mountKnowledgePicker(container, { value: ["a"], onChange: (value) => { selections.set("dialog", value); dialogPicker.update({ value }); } }, { signal });
				return () => { dialogCleanups++; };
			} }, { signal: scope.signal });
		},
		async click(selector: string) {
			const element = document.querySelector<HTMLElement>(selector); assert.ok(element, selector);
			await act(async () => { element.focus(); element.click(); });
		},
		async key(key: string, shiftKey = false) {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key, shiftKey });
			await act(async () => { (document.activeElement ?? document).dispatchEvent(event); });
		},
		async dispose() {
			await act(async () => { lifetime.abort(); scope.abort(); root.unmount(); owner.manager.dispose(); });
			dom.window.HTMLElement.prototype.focus = originalFocus; dom.window.HTMLInputElement.prototype.select = originalSelect; dom.window.HTMLInputElement.prototype.click = originalClick;
			for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
		},
	};
	return f;
}
const picker = () => document.querySelector<HTMLElement>('[data-testid="chain-table-overlay"]');
const settings = () => document.querySelector<HTMLElement>('[data-testid="settings-dialog"]');
function assertSuspended(frame: HTMLElement) {
	for (const element of [frame, frame.parentElement!]) {
		assert.equal(element.hidden, true); assert.equal(element.hasAttribute("inert"), true); assert.equal(element.style.display, "none");
	}
}
async function closePicker(f: Fixture, action: "Done" | "X" | "Escape") {
	if (action === "Escape") await f.key("Escape");
	else await f.click(`[data-testid="${action === "Done" ? "chain-practice-done" : "chain-table-close"}"]`);
	assert.equal(picker(), null);
}

for (const origin of ["settings", "dialog"] as const) for (const action of ["Done", "X", "Escape"] as const) {
	it(`${origin} stays mounted with its own state/focus while ${action} closes only the selector`, async () => {
		const f = await fixture();
		try {
			await act(async () => { if (origin === "settings") f.openSettings(); else f.openDialog(); });
			const frame = origin === "settings" ? settings()! : document.querySelector<HTMLElement>('[data-plugin-ui-dialog]')!;
			const input = frame.querySelector<HTMLInputElement>(`[data-testid="${origin}-owned-input"]`)!;
			input.value = "unsaved state";
			const trigger = frame.querySelector<HTMLElement>('[data-testid="practice-props-chip"]')!;
			await f.click(`${origin === "settings" ? '[data-testid="settings-dialog"]' : '[data-plugin-ui-dialog]'} [data-testid="practice-props-chip"]`);
			assertSuspended(frame); assert.equal(input.isConnected, true); assert.equal(input.value, "unsaved state");
			assert.equal(picker()?.parentElement, f.content); assert.equal(f.settingsCleanups + f.dialogCleanups, 0);
			await closePicker(f, action);
			assert.equal(frame.hidden, false); assert.notEqual(frame.style.display, "none");
			assert.equal(frame.querySelector("input"), input); assert.equal(input.value, "unsaved state");
			assert.equal(document.activeElement, trigger); assert.equal(f.settingsMounts + f.dialogMounts, 1);
			assert.equal(f.settingsCleanups + f.dialogCleanups, 0);
			assert.deepEqual(f.errors, []);
		} finally { await f.dispose(); }
	});
}

it("a later Settings open closes the main selector and closing Settings never resumes it", async () => {
	const f = await fixture();
	try {
		await f.click('#main-picker [data-testid="practice-props-chip"]');
		document.querySelector<HTMLElement>("#launcher")!.focus();
		await act(async () => { f.openSettings(); });
		assert.equal(settings()!.hidden, false); assert.ok(settings()!.contains(document.activeElement));
		assert.equal(picker(), null);
		await f.key("Escape"); assert.equal(settings(), null); assert.equal(picker(), null);
		assert.match(document.querySelector("#main-picker")!.textContent!, /1 node selected/);
	} finally { await f.dispose(); }
});

it("a newer public dialog/menu stays above the selector, and controlled dialog updates never reactivate origins", async () => {
	const f = await fixture();
	try {
		let origin!: PluginWidgetHandle<PluginDialogProps>;
		await act(async () => { origin = f.openDialog(); });
		await f.click('[data-plugin-ui-dialog] [data-testid="practice-props-chip"]');
		const oldFrame = document.querySelector<HTMLElement>('[data-plugin-ui-dialog]')!;
		await act(async () => { origin.update({ title: "Updated while suspended" }); });
		assertSuspended(oldFrame); assert.equal(f.dialogMounts, 1);
		await act(async () => { f.ui.openDialog({ title: "Later", content: document.createElement("input") }, { signal: f.scope.signal }); });
		const later = document.querySelector<HTMLElement>('[aria-label="Later"]')!;
		assert.equal(later.hidden, false); assert.equal(document.activeElement, later); assert.ok(picker());
		await f.key("Escape"); assert.equal(document.querySelector('[aria-label="Later"]'), null); assert.ok(picker()!.contains(document.activeElement));
		await act(async () => { f.ui.openMenu(document.querySelector<HTMLElement>("#launcher")!, { items: [{ key: "one", label: "One", onSelect() {} }] }, { signal: f.scope.signal }); });
		await f.key("Escape"); assert.equal(document.querySelector("[data-lh-menu]"), null); assert.ok(picker());
		await closePicker(f, "X"); assert.equal(oldFrame.hidden, false);
	} finally { await f.dispose(); }
});

for (const sameSection of [true, false]) it(`explicit Settings ${sameSection ? "same-section reopen" : "retarget"} unsuspends its new generation`, async () => {
	const f = await fixture();
	try {
		await act(async () => { f.openSettings(); });
		await f.click('[data-testid="settings-dialog"] [data-testid="practice-props-chip"]'); assertSuspended(settings()!);
		await act(async () => { f.openSettings(sameSection ? "plugin:fixture" : "keyboard"); });
		assert.equal(settings()!.hidden, false); assert.ok(settings()!.contains(document.activeElement));
		if (sameSection) { assert.equal(picker(), null); assert.equal(f.settingsMounts, 1); }
		else { assert.equal(picker(), null, "retargeting disposes the old plugin-settings lifetime"); assert.equal(f.settingsCleanups, 1); }
		await f.key("Escape"); assert.equal(settings(), null); assert.equal(picker(), null);
	} finally { await f.dispose(); }
});

it("Settings open aborts a pending main-selector read and stale completion cannot promote it", async () => {
	const pending = deferred<Response>();
	const f = await fixture({ fetchGraph: async () => pending.promise });
	try {
		await f.click('#main-picker [data-testid="practice-props-chip"]');
		await act(async () => { f.openSettings(); });
		const focused = document.activeElement;
		await act(async () => { pending.resolve(Response.json(graph)); });
		assert.equal(picker(), null); assert.equal(settings()!.hidden, false); assert.equal(document.activeElement === focused, true);
		assert.equal(f.requests.find((r) => r.url === "/api/graph")!.init!.signal!.aborted, true);
		await f.key("Escape"); assert.equal(settings(), null); assert.equal(picker(), null);
	} finally { await f.dispose(); }
});

it("same-instance Settings reopen during a pending graph read remains visible when that read completes", async () => {
	const pending = deferred<Response>();
	const f = await fixture({ fetchGraph: async () => pending.promise });
	try {
		await act(async () => { f.openSettings(); });
		await f.click('[data-testid="settings-dialog"] [data-testid="practice-props-chip"]');
		assert.equal(settings()!.hidden, false, "reserving a load never hides its origin");
		await act(async () => { f.openSettings(); pending.resolve(Response.json(graph)); });
		assert.equal(settings()!.hidden, false); assert.ok(settings()!.contains(document.activeElement)); assert.equal(picker(), null);
	} finally { await f.dispose(); }
});

it("two pending pickers replace, abort stale reads and never resume the old selection owner", async () => {
	const pending = [deferred<Response>(), deferred<Response>()]; let calls = 0;
	const f = await fixture({ fetchGraph: async () => pending[calls++]!.promise });
	try {
		await f.click('#main-picker [data-testid="practice-props-chip"]');
		const firstSignal = f.requests.find((r) => r.url === "/api/graph")!.init!.signal!;
		await f.click('#second-picker [data-testid="practice-props-chip"]'); assert.equal(firstSignal.aborted, true);
		await act(async () => { pending[1]!.resolve(Response.json(graph)); }); assert.ok(picker());
		await act(async () => { f.main.dispose(); pending[0]!.resolve(Response.json(graph)); });
		assert.equal(document.querySelectorAll('[data-testid="chain-table-overlay"]').length, 1);
		await closePicker(f, "X"); assert.equal(picker(), null);
		assert.match(document.querySelector("#second-picker")!.textContent!, /1 node selected/);
	} finally { await f.dispose(); }
});

for (const ending of ["close settings", "dispose dialog", "disable", "abort"] as const) it(`${ending} never resurrects a suspended/closed origin`, async () => {
	const f = await fixture();
	try {
		let dialog!: PluginWidgetHandle<PluginDialogProps>;
		await act(async () => { if (ending === "dispose dialog") dialog = f.openDialog(); else f.openSettings(); });
		await f.click(`${ending === "dispose dialog" ? '[data-plugin-ui-dialog]' : '[data-testid="settings-dialog"]'} [data-testid="practice-props-chip"]`);
		assert.ok(picker());
		await act(async () => {
			if (ending === "dispose dialog") dialog.dispose();
			else if (ending === "close settings") document.querySelector<HTMLElement>('[data-testid="settings-close"]')!.click();
			else if (ending === "disable") f.settingsHandle.update({ disabled: true });
			else f.settingsHandle.dispose();
		});
		assert.equal(picker(), null);
		if (ending === "dispose dialog") assert.equal(document.querySelector('[data-plugin-ui-dialog]'), null);
		else if (ending === "close settings") assert.equal(settings(), null);
		else assert.equal(settings()!.hidden, false);
	} finally { await f.dispose(); }
});

it("Tab/Shift-Tab while the selector is foreground never dispatches background composer/thinking cycles", async () => {
	const f = await fixture(); let dispatched = 0;
	const count = () => { dispatched++; };
	window.addEventListener("lh:kbd-cycle-fields", count); window.addEventListener("lh:kbd-cycle-thinking", count);
	try {
		await f.click('#main-picker [data-testid="practice-props-chip"]');
		await f.key("Tab"); await f.key("Tab", true); assert.equal(dispatched, 0);
		await closePicker(f, "X");
		await f.key("Tab"); await f.key("Tab", true); assert.equal(dispatched, 2, "existing global contracts remain when no selector owns foreground");
	} finally { window.removeEventListener("lh:kbd-cycle-fields", count); window.removeEventListener("lh:kbd-cycle-thinking", count); await f.dispose(); }
});

it("accepted source organization writes continue when a newer modal opens and the selector is disposed", async () => {
	const write = deferred<Response>(); let accepted = false;
	const f = await fixture({ write: async (init) => { accepted = true; assert.equal(init?.signal, undefined); return write.promise; } });
	try {
		await f.click('#main-picker [data-testid="practice-props-chip"]');
		const event = new f.dom.window.Event("drop", { bubbles: true, cancelable: true });
		Object.assign(event, { dataTransfer: { getData: () => JSON.stringify({ kind: "source", id: "chat" }) } });
		await act(async () => { document.querySelector('[data-testid="source-root-drop"]')!.dispatchEvent(event); });
		assert.equal(accepted, true);
		await act(async () => { f.openSettings(); f.main.dispose(); });
		assert.equal(picker(), null); assert.equal(settings()!.hidden, false);
		await act(async () => { write.resolve(Response.json(directory)); });
		assert.equal(settings()!.hidden, false); assert.deepEqual(f.errors, []);
	} finally { await f.dispose(); }
});

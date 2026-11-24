import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { registerSurfaceBoundary } from "../components/plugin-surface-targets.ts";
import { usePluginShortcutPage } from "../components/plugin-shortcuts.tsx";
import { createPluginSessionActionContext, loadOverrides, saveOverrides, type PluginActionContext, type PluginFrontendContext } from "../src/core/index.ts";
import { mountPluginChrome, pluginInfo } from "./helpers/plugin-chrome.tsx";
(globalThis as Record<string, unknown>).React = React;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function storage() {
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
}

async function domFixture(settings = false) {
	let controller!: InteractionLayersController;
	const calls: PluginActionContext[] = [];
	let enabled = true, actionOff!: () => void;
	function Probe() {
		controller = useInteractionLayers();
		usePluginShortcutPage("/plugins/fixture/overview", () => ({ surface: "plugin-view", pluginId: "fixture", viewId: "overview" }));
		return <div data-testid="pane"><input data-testid="editor" /><div data-session-surface-region=""><div data-session-surface-mounts="" /><div data-testid="foreground" /></div></div>;
	}
	const f = await mountPluginChrome({ activate(ctx) {
		actionOff = ctx.registerAction({ id: "draw", name: "Draw", shortcut: { scope: { views: ["overview"] }, defaultBinding: "mod+shift+d" }, disabled: () => !enabled, run: context => { calls.push(context); } });
		ctx.registerAction({ id: "library", name: "Library", shortcut: { scope: "app" }, run: context => { calls.push(context); } });
	} }, <><Probe />{settings ? <KeyboardSection /> : <KeyboardShortcuts />}</>);
	storage();
	const lifetime = new AbortController();
	registerSurfaceBoundary(f.document.querySelector<HTMLElement>("[data-testid=pane]")!, lifetime.signal, controller);
	const key = async (name: string, extra: Record<string, unknown> = {}, target: HTMLElement = f.document.body) => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, ...extra });
		await act(async () => { controller.captureKeyDown(event as KeyboardEvent); target.dispatchEvent(event); });
		return event;
	};
	return { ...f, calls, controller, key, disable: () => { enabled = false; }, unregister: () => actionOff(), async finish() { lifetime.abort(); await f.close(); } };
}

test("keyboard invokes the registered action with a truthful current-page context and claims the event", async () => {
	const f = await domFixture();
	try {
		const event = await f.key("d", { metaKey: true, shiftKey: true });
		assert.equal(event.defaultPrevented, true);
		assert.deepEqual(f.calls, [{ placement: "keyboard", surface: "plugin-view", pluginId: "fixture", viewId: "overview" }]);
		for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) await f.key("d", { metaKey: true, shiftKey: true, ...extra });
		assert.equal(f.calls.length, 1);
		f.disable(); assert.equal((await f.key("d", { metaKey: true, shiftKey: true })).defaultPrevented, false);
		await act(async () => f.unregister()); await f.key("d", { metaKey: true, shiftKey: true }); assert.equal(f.calls.length, 1);
	} finally { await f.finish(); }
});

test("a leaf editor retains first refusal over plugin shortcuts", async () => {
	const f = await domFixture();
	try {
		const editor = f.document.querySelector<HTMLElement>("[data-testid=editor]")!;
		const claim = (event: Event) => event.preventDefault(); editor.addEventListener("keydown", claim);
		await f.key("d", { metaKey: true, shiftKey: true }, editor); assert.equal(f.calls.length, 0);
		editor.removeEventListener("keydown", claim);
		await f.key("d", { metaKey: true, shiftKey: true }, editor); assert.equal(f.calls.length, 1);
	} finally { await f.finish(); }
});

for (const kind of ["modal", "popup", "view"] as const) test(`${kind} foreground blocks plugin shortcuts, including app-wide actions`, async () => {
	const f = await domFixture();
	try {
		const element = f.document.querySelector<HTMLElement>("[data-testid=foreground]")!;
		const off = f.controller.register({ id: "cover", kind, rootRef: { current: element } });
		await act(async () => saveOverrides({ "plugin:fixture:library": "mod+shift+l" }));
		await f.key("d", { metaKey: true, shiftKey: true }); await f.key("l", { metaKey: true, shiftKey: true });
		assert.equal(f.calls.length, 0); off();
		await f.key("d", { metaKey: true, shiftKey: true }); assert.equal(f.calls.length, 1);
	} finally { await f.finish(); }
});

test("only an own-plugin page-body surface allows its shortcut; a closed original owner never exposes the page", async () => {
	const f = await domFixture();
	try {
		const element = f.document.querySelector<HTMLElement>("[data-testid=foreground]")!;
		element.setAttribute("data-plugin-shortcut-owner", "fixture");
		let off = f.controller.register({ id: "own", kind: "view", rootRef: { current: element } });
		await f.key("d", { metaKey: true, shiftKey: true }); assert.equal(f.calls.length, 1);
		element.setAttribute("data-plugin-shortcut-owner", "foreign");
		await f.key("d", { metaKey: true, shiftKey: true }); assert.equal(f.calls.length, 1);
		const close = () => off(); element.addEventListener("keydown", close);
		await f.key("d", { metaKey: true, shiftKey: true }, element); assert.equal(f.calls.length, 1);
		element.removeEventListener("keydown", close);
		off = f.controller.register({ id: "native", kind: "view", rootRef: { current: element } }); off();
	} finally { await f.finish(); }
});

test("Settings rebinds, clears and resets plugin overrides in the existing keymap without losing core settings", async () => {
	const f = await domFixture(true);
	try {
		await act(async () => saveOverrides({ "open-settings": "mod+shift+," }));
		const button = (id: string) => f.document.querySelector<HTMLElement>(`[data-testid='${id}']`)!;
		assert.match(f.document.body.textContent!, /Library/); assert.match(f.document.body.textContent!, /Unbound/);
		await f.click(button("kbd-rebind-plugin:fixture:draw"));
		await f.key("k", { metaKey: true });
		assert.match(f.document.querySelector("[role=alert]")!.textContent!, /core shortcut/);
		assert.equal(loadOverrides()["plugin:fixture:draw"], undefined);
		await f.key("j", { metaKey: true, shiftKey: true });
		assert.equal(loadOverrides()["plugin:fixture:draw"], "mod+shift+j");
		assert.equal(loadOverrides()["open-settings"], "mod+shift+,");
		await f.click(button("kbd-clear-plugin:fixture:draw")); assert.equal(loadOverrides()["plugin:fixture:draw"], "");
		await f.click(button("kbd-reset-plugin:fixture:draw")); assert.equal(loadOverrides()["plugin:fixture:draw"], undefined);
		assert.equal(loadOverrides()["open-settings"], "mod+shift+,");
	} finally { await f.finish(); }
});

test("manager captures shortcut metadata, validates defaults, preserves action busy/errors and fences stale page readers", async () => {
	let ctx!: PluginFrontendContext, complete!: () => void, pathname = "/";
	const manager = new PluginFrontendManager({ fetch: async () => Response.json({}), importModule: async () => ({ activate(value) { ctx = value; } }), pathname: () => pathname, navigate() {} });
	manager.reconcile([pluginInfo()]); await tick();
	try {
		assert.throws(() => ctx.registerAction({ id: "bad", name: "Bad", shortcut: { scope: "app", defaultBinding: "tab" }, run() {} }), /shortcut/);
		const sessions: ("teaching" | "practice")[] = ["teaching"];
		ctx.registerAction({ id: "wait", name: "Wait", shortcut: { scope: { sessions }, defaultBinding: "mod+shift+w" }, run: () => new Promise<void>(resolve => { complete = resolve; }) });
		sessions.push("practice"); assert.deepEqual(manager.getSnapshot().plugins[0]!.shortcuts![0]!.shortcut.scope, { sessions: ["teaching"] });
		const action = manager.getSnapshot().plugins[0]!.actions[0]!;
		assert.equal(manager.tryRunAction("fixture", action, () => ({ placement: "keyboard", surface: "app", pathname })), true);
		assert.equal(manager.tryRunAction("fixture", action, () => ({ placement: "keyboard", surface: "app", pathname })), false);
		complete(); await tick(); assert.deepEqual(manager.getSnapshot().plugins[0]!.actionBusy, []);
		const old = manager.registerShortcutPage("/plugins/fixture/overview", () => ({ surface: "plugin-view", pluginId: "fixture", viewId: "old" }));
		manager.registerShortcutPage("/plugins/fixture/overview", () => ({ surface: "plugin-view", pluginId: "fixture", viewId: "new" })); old();
		assert.deepEqual(manager.shortcutPageContext(), { surface: "app", pathname: "/" });
		pathname = "/plugins/fixture/overview"; assert.equal((manager.shortcutPageContext() as { viewId: string }).viewId, "new");
		pathname = "/chat/missing"; assert.equal(manager.shortcutPageContext(), undefined);
		ctx.registerAction({ id: "fail", name: "Fail", run() { throw new Error("action failed"); } });
		await manager.runAction("fixture", manager.getSnapshot().plugins[0]!.actions[1]!, { placement: "keyboard", surface: "app", pathname });
		assert.match(manager.getSnapshot().plugins[0]!.error!, /action failed/);
		manager.reconcile([{ ...pluginInfo(), enabled: false }]); assert.deepEqual(manager.getSnapshot().plugins[0]!.shortcuts, []);
	} finally { manager.dispose(); }
});

test("session keyboard invocation captures a fresh immutable whole-view snapshot on each press", async () => {
	const f = await domFixture(); let draft = "first";
	const target = Object.freeze({}) as Extract<PluginActionContext, { surface: "session" }>["surfaceTarget"];
	try {
		const off = f.owner.manager.registerShortcutPage("/plugins/fixture/overview", () => createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: "fixture", kind: "teaching", surfaceTarget: target }, () => ({ sessionId: "fixture", kind: "teaching", title: "Fixture", messages: [], transcript: [], status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: "probe", contextTokens: null, queuedSteers: [], composer: { text: draft }, input: { type: "unavailable", expanded: false, revealed: false } })));
		// App-wide eligibility still receives the actual current session, not an app placeholder.
		await act(async () => saveOverrides({ "plugin:fixture:library": "mod+shift+l" }));
		const plugin = f.owner.manager.getSnapshot().plugins[0]!;
		plugin.actions.find(action => action.id === "library")!.run = context => { f.calls.push(context); };
		await f.key("l", { metaKey: true, shiftKey: true }); draft = "second";
		await f.key("l", { metaKey: true, shiftKey: true });
		const contexts = f.calls as Extract<PluginActionContext, { surface: "session" }>[];
		assert.equal(contexts[0]!.view.composer.text, "first"); assert.equal(contexts[1]!.view.composer.text, "second");
		assert.ok(Object.isFrozen(contexts[0]!.view.composer)); assert.equal(contexts[0]!.placement, "keyboard"); off();
	} finally { await f.finish(); }
});

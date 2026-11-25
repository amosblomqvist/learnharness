import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPluginUiStore, PluginUiHost } from "../components/plugin-ui-host.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
(globalThis as Record<string, unknown>).React = React;

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div><div id='slot'></div><button id='anchor'>Anchor</button><button id='other'>Other</button></body></html>");
	const values = { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const restore = installModalDom(dom);
	function setup() {
		const store = createPluginUiStore(), lifetime = new AbortController(), caller = new AbortController(), errors: unknown[] = [];
		const ui = store.createUi({ signal: lifetime.signal, pluginId: "same-plugin", onError: error => errors.push(error) });
		const anchor = document.querySelector<HTMLElement>("#anchor")!, other = document.querySelector<HTMLElement>("#other")!;
		const open = (onClose?: () => void | Promise<void>) => ui.openMenu(anchor, { items: [], onClose }, { signal: caller.signal });
		const event = (target: EventTarget, type: string, fields = {}) => target.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), fields));
		return { store, lifetime, caller, ui, errors, anchor, other, open, event };
	}
	const f = setup();
	try { await run(f); }
	finally {
		f.lifetime.abort(); restore();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
}

it("same-owner exact-anchor calls toggle before React mounts; latest close and returned/stale handles are safe", () => fixture(async f => {
	const calls: string[] = [];
	const old = f.open(() => { calls.push("old"); });
	old.update({ onClose: () => { calls.push("latest"); } });
	const inert = f.open(() => { calls.push("incoming must not run"); });
	assert.equal(f.store.getSnapshot().length, 0);
	assert.deepEqual(calls, ["latest"]);
	const successor = f.open(() => { calls.push("successor"); });
	for (const handle of [old, inert]) { handle.update({ label: "stale", onClose() { assert.fail("stale callback"); } }); handle.dispose(); }
	assert.equal(f.store.getSnapshot().length, 1);
	assert.notEqual((f.store.getSnapshot()[0]!.props as { label?: string }).label, "stale");
	f.open(); assert.equal(f.store.getSnapshot().length, 0);
	assert.deepEqual(calls, ["latest", "successor"]);
	successor.dispose();
}));

it("owner identity is the createUi instance, not pluginId; other anchors and owners retain separate menus", () => fixture(async f => {
	const otherUi = f.store.createUi({ signal: f.lifetime.signal, pluginId: "same-plugin" });
	let first = 0, second = 0, otherAnchor = 0;
	f.open(() => { first++; });
	otherUi.openMenu(f.anchor, { items: [], onClose() { second++; } }, { signal: f.caller.signal });
	f.ui.openMenu(f.other, { items: [], onClose() { otherAnchor++; } }, { signal: f.caller.signal });
	assert.equal(f.store.getSnapshot().length, 3);
	f.open(); assert.equal(f.store.getSnapshot().length, 2);
	assert.deepEqual([first, second, otherAnchor], [1, 0, 0]);
}));

for (const expiry of ["dispose", "caller"] as const) it(`${expiry} removes anchor tracking without onClose; stale handles cannot affect a new menu`, () => fixture(async f => {
	let closes = 0;
	const old = f.open(() => { closes++; });
	if (expiry === "dispose") old.dispose(); else f.caller.abort();
	assert.equal(closes, 0);
	const live = new AbortController();
	f.ui.openMenu(f.anchor, { items: [], onClose() { closes++; } }, { signal: live.signal });
	old.dispose(); assert.equal(f.store.getSnapshot().length, 1);
	f.ui.openMenu(f.anchor, { items: [] }, { signal: live.signal });
	assert.equal(closes, 1); assert.equal(f.store.getSnapshot().length, 0);
}));

it("aborted/disconnected calls stay inert and do not toggle a live menu; plugin abort disposes without notification", () => fixture(async f => {
	let closes = 0; f.open(() => { closes++; });
	const dead = new AbortController(); dead.abort();
	f.ui.openMenu(f.anchor, { items: [] }, { signal: dead.signal });
	f.anchor.remove(); f.open();
	assert.equal(f.store.getSnapshot().length, 1); assert.equal(closes, 0);
	f.lifetime.abort(); assert.equal(f.store.getSnapshot().length, 0); assert.equal(closes, 0);
	f.open(); assert.equal(f.store.getSnapshot().length, 0);
}));

it("close is idempotent on callback reentry/errors and a reentrant successor survives old cleanup", () => fixture(async f => {
	let closes = 0;
	const old = f.open(() => { closes++; f.open(); throw Error("close failed"); });
	f.open(); old.dispose();
	assert.equal(closes, 1); assert.equal(f.errors.length, 1); assert.equal(f.store.getSnapshot().length, 1);
	f.open(); assert.equal(f.store.getSnapshot().length, 0);
	f.open(async () => { throw Error("async close failed"); }); f.open();
	await Promise.resolve(); assert.equal(f.errors.length, 2); assert.equal(f.store.getSnapshot().length, 0);
}));

it("the anchor is registered before synchronous store subscribers can reenter openMenu", () => fixture(async f => {
	let reentered = false, closes = 0;
	const unsubscribe = f.store.subscribe(() => {
		if (!reentered && f.store.getSnapshot().length) { reentered = true; f.open(); }
	});
	try { f.open(() => { closes++; }); assert.equal(closes, 1); assert.equal(f.store.getSnapshot().length, 0); }
	finally { unsubscribe(); }
}));

it("late action completion cannot close a successor; failed actions still report and keep the menu", () => fixture(async f => {
	const root = createRoot(document.querySelector("#root")!);
	let release!: () => void;
	try {
		await act(async () => {
			root.render(<InteractionLayersProvider><PluginUiHost store={f.store} /></InteractionLayersProvider>);
			f.ui.openMenu(f.anchor, { items: [{ key: "slow", label: "Slow", onSelect: () => new Promise<void>(resolve => { release = resolve; }) }] }, { signal: f.caller.signal });
		});
		await act(async () => { f.event(document.querySelector('[role="menuitem"]')!, "click"); });
		await act(async () => { f.open(); f.open(); });
		assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
		await act(async () => { release(); });
		assert.equal(document.querySelectorAll('[role="menu"]').length, 1, "old action must not close the successor");
		await act(async () => {
			f.open();
			f.ui.openMenu(f.anchor, { items: [{ key: "fail", label: "Fail", onSelect() { throw Error("selection failed"); } }] }, { signal: f.caller.signal });
		});
		await act(async () => { f.event(document.querySelector('[role="menuitem"]')!, "click"); });
		assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /selection failed/);
		assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
	} finally { await act(async () => { f.lifetime.abort(); root.unmount(); }); }
}));

it("actual host button clicks are 1/0/1; other button, Escape/focus, keyboard and action still work", () => fixture(async f => {
	const root = createRoot(document.querySelector("#root")!); let closes = 0, actions = 0;
	try {
		await act(async () => {
			root.render(<InteractionLayersProvider><PluginUiHost store={f.store} /></InteractionLayersProvider>);
			f.ui.mountButton(document.querySelector("#slot")!, { label: "Gear", onClick() {
				const anchor = document.querySelector<HTMLElement>("#slot button")!;
				f.ui.openMenu(anchor, { items: [{ key: "one", label: "One", onSelect() { actions++; } }], onClose() { closes++; } }, { signal: f.caller.signal });
			} }, { signal: f.caller.signal });
		});
		const gear = document.querySelector<HTMLElement>("#slot button")!;
		const click = async (button: HTMLElement) => act(async () => { for (const type of ["pointerdown", "pointerup", "click"]) f.event(button, type, { pointerId: 1, button: 0, isPrimary: true }); });
		for (const expected of [1, 0, 1]) { await click(gear); assert.equal(document.querySelectorAll('[role="menu"]').length, expected); }
		await click(f.other); assert.equal(document.querySelectorAll('[role="menu"]').length, 0);
		await click(gear);
		await act(async () => { f.event(document, "keydown", { key: "Escape" }); });
		assert.equal(document.querySelectorAll('[role="menu"]').length, 0); assert.equal(document.activeElement, gear);
		await click(gear);
		await act(async () => { f.event(document.querySelector('[data-testid="plugin-menu"]')!, "keydown", { key: "ArrowDown" }); });
		assert.equal(document.activeElement, document.querySelector('[role="menuitem"]'));
		await click(document.querySelector<HTMLElement>('[role="menuitem"]')!);
		assert.equal(actions, 1); assert.equal(closes, 4); assert.equal(document.querySelectorAll('[role="menu"]').length, 0);
	} finally { await act(async () => { f.lifetime.abort(); root.unmount(); }); }
}));

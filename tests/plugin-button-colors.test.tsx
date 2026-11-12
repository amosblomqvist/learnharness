import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPluginUiStore, PluginUiHost } from "../components/plugin-ui-host.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { PluginButtonColors, PluginButtonProps, PluginWidgetHandle } from "../src/core/plugin-ui.ts";

const supported = ["#123456", "#654321", "#102030", "white", "black", "transparent", "var(--fixture-accent)", "rgb(1 2 3 / 0.25)", "currentColor", "color-mix(in srgb, red 50%, blue)"];
async function withColors(run: (f: { target: HTMLElement; parserCalls: string[]; ui: ReturnType<ReturnType<typeof createPluginUiStore>["createUi"]>; store: ReturnType<typeof createPluginUiStore>; scope: AbortController; render(): Promise<void> }) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div><div id='target'>caller-owned</div></body></html>");
	const parserCalls: string[] = [];
	// Browser-owned parser dependency, not a replacement CSS parser. The actual
	// supported/unsupported examples are also checked with Chromium CSS.supports.
	const values = { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
		CSS: { supports(property: string, value: string) { assert.equal(property, "color"); parserCalls.push(value); return supported.includes(value); } } };
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values); const restore = installModalDom(dom);
	const scope = new AbortController(), store = createPluginUiStore(), ui = store.createUi({ signal: scope.signal });
	const root = createRoot(document.querySelector("#root")!), target = document.querySelector<HTMLElement>("#target")!;
	try { await run({ target, parserCalls, ui, store, scope, async render() { await act(async () => root.render(<React.StrictMode><InteractionLayersProvider><PluginUiHost store={store} /></InteractionLayersProvider></React.StrictMode>)); } }); }
	finally {
		await act(async () => { scope.abort(); root.unmount(); }); restore();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
}

it("custom button colors flow through the controlled native button and replace shallowly without replacing DOM", () => withColors(async f => {
	await f.render(); let handle!: PluginWidgetHandle<PluginButtonProps>, calls = 0;
	const colors: PluginButtonColors = { background: "#123456", text: "white", border: "black", hover: { background: "#654321" },
		active: { text: "black" }, focusVisible: { border: "white", ring: "var(--fixture-accent)" }, disabled: { text: "#102030" } };
	await act(async () => { handle = f.ui.mountButton(f.target, { label: "Rate", variant: "custom", colors, onClick() { calls++; } }, { signal: f.scope.signal }); });
	const button = f.target.querySelector("button")!;
	assert.equal(button.dataset.variant, "custom"); assert.equal(button.hasAttribute("colors"), false);
	assert.equal(button.style.getPropertyValue("--button-custom-background"), "#123456");
	assert.equal(button.style.getPropertyValue("--button-custom-hover-background"), "#654321");
	assert.equal(button.style.getPropertyValue("--button-custom-active-text"), "black");
	assert.equal(button.style.getPropertyValue("--button-custom-focus-visible-ring"), "var(--fixture-accent)");
	assert.equal(button.style.getPropertyValue("--button-custom-disabled-text"), "#102030");
	assert.equal(button.style.getPropertyValue("--button-custom-active-background"), "", "omitted state slots never reset lower states");
	await act(async () => { handle.update({ colors: { text: "#654321" }, onClick() { calls += 10; } }); });
	assert.ok(f.target.querySelector("button") === button); assert.equal(button.style.getPropertyValue("--button-custom-background"), "");
	assert.equal(button.style.getPropertyValue("--button-custom-hover-background"), "");
	assert.equal(button.style.getPropertyValue("--button-custom-text"), "#654321");
	await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); }); assert.equal(calls, 10);
	await act(async () => { handle.update({ variant: "outline" }); });
	assert.equal(button.dataset.variant, "outline"); assert.equal(button.style.getPropertyValue("--button-custom-text"), "", "other variants ignore, but retain, valid colors");
	await act(async () => { handle.update({ variant: "custom", disabled: true }); });
	assert.equal(button.style.getPropertyValue("--button-custom-text"), "#654321"); assert.equal(button.hasAttribute("disabled"), true);
	await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); }); assert.equal(calls, 10);
	await act(async () => { handle.update({ colors: undefined }); });
	assert.equal(button.style.getPropertyValue("--button-custom-text"), ""); assert.ok(f.target.querySelector("button") === button);
}));

it("button color shape and browser color syntax reject mount/update atomically even outside custom", () => withColors(async f => {
	const invalid: unknown[] = [null, [], "red", 42, { surprise: "white" }, { text: 3 }, { background: " " }, { border: "not-a-color" },
		{ hover: null }, { active: [] }, { disabled: "white" }, { focusVisible: { ring: false } }, { hover: { ring: "white" } },
		{ backgroundColor: "white" }, { focusVisible: { outline: "white" } }, { hover: { background: "red; position:fixed" } },
		{ text: "url(https://example.invalid/image)" }];
	for (const value of invalid) {
		assert.throws(() => f.ui.mountButton(f.target, { label: "Invalid", colors: value as PluginButtonColors, onClick() {} }, { signal: f.scope.signal }), TypeError);
		assert.equal(f.target.textContent, "caller-owned"); assert.equal(f.store.getSnapshot().length, 0);
	}
	const handle = f.ui.mountButton(f.target, { label: "Original", variant: "custom", colors: { text: "white" }, onClick() {} }, { signal: f.scope.signal });
	const snapshot = f.store.getSnapshot();
	for (const value of invalid) {
		assert.throws(() => handle.update({ label: "Rejected", colors: value as PluginButtonColors }), TypeError);
		assert.ok(f.store.getSnapshot() === snapshot); assert.equal((snapshot[0]!.props as PluginButtonProps).label, "Original");
	}
	assert.ok(f.parserCalls.includes("not-a-color"), "syntax checks use the browser color grammar");
	f.scope.abort(); const count = f.parserCalls.length;
	assert.doesNotThrow(() => handle.update({ colors: null as unknown as PluginButtonColors }));
	assert.doesNotThrow(() => f.ui.mountButton(f.target, { label: "Aborted", colors: null as unknown as PluginButtonColors, onClick() {} }, { signal: f.scope.signal }));
	assert.equal(f.parserCalls.length, count); assert.equal(f.target.textContent, "caller-owned");
}));

it("button colors accept optional slots, CSS variables and native color expressions without interpreting or persisting them", () => withColors(async f => {
	for (const value of supported) {
		const colors: PluginButtonColors = { background: value, hover: { text: value }, active: { border: value }, focusVisible: { ring: value }, disabled: { background: value } };
		const handle = f.ui.mountButton(f.target, { label: "Valid", colors, onClick() {} }, { signal: f.scope.signal });
		assert.deepEqual((f.store.getSnapshot().at(-1)!.props as PluginButtonProps).colors, colors);
		handle.dispose();
	}
	const optional: PluginButtonColors = { text: undefined, hover: undefined, active: {}, focusVisible: { ring: undefined }, disabled: {} };
	const handle = f.ui.mountButton(f.target, { label: "Optional", variant: "custom", colors: optional, onClick() {} }, { signal: f.scope.signal }); handle.dispose();
	assert.equal(f.target.textContent, "caller-owned");
	assert.equal(f.parserCalls.length, supported.length * 5, "undefined slots do not call or replace the parser");
}));

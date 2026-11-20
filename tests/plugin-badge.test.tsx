import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPluginUiStore, PluginUiHost } from "../components/plugin-ui-host.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { PluginBadgeProps, PluginWidgetHandle } from "../src/core/plugin-ui.ts";

const colors = ["red", "#123456", "var(--plugin-accent)", "rgb(1 2 3 / .5)", "transparent", "currentColor", "color-mix(in srgb, red 50%, blue)"];
async function withBadge(run: (f: {
	target: HTMLElement; scope: AbortController; widget: AbortController;
	ui: ReturnType<ReturnType<typeof createPluginUiStore>["createUi"]>;
	store: ReturnType<typeof createPluginUiStore>; parserCalls: [string, string][];
}) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div><div id='target'>caller-owned</div></body></html>");
	const parserCalls: [string, string][] = [];
	// Dependency stub only: real Chromium also exercises the CSS parser and paint.
	const values = { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
		CSS: { supports(property: string, value: string) {
			parserCalls.push([property, value]);
			return property === "color" ? colors.includes(value) || value === "inherit" :
				property === "background-color" && colors.some(color => value === `color-mix(in oklab, ${color} 15%, transparent)`);
		} } };
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values); const restore = installModalDom(dom);
	const scope = new AbortController(), widget = new AbortController(), store = createPluginUiStore();
	const ui = store.createUi({ signal: scope.signal });
	const root = createRoot(document.querySelector("#root")!), target = document.querySelector<HTMLElement>("#target")!;
	try {
		await act(async () => root.render(<React.StrictMode><InteractionLayersProvider><PluginUiHost store={store} /></InteractionLayersProvider></React.StrictMode>));
		await run({ target, scope, widget, ui, store, parserCalls });
	} finally {
		await act(async () => { scope.abort(); root.unmount(); }); restore();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
}

it("mountBadge renders plugin-owned plain text through the shared native component and updates in place", () => withBadge(async f => {
	let handle!: PluginWidgetHandle<PluginBadgeProps>;
	await act(async () => { handle = f.ui.mountBadge(f.target, { text: "Tests passed", color: "#123456" }, { signal: f.widget.signal }); });
	const badge = f.target.querySelector<HTMLElement>('[data-slot="status-badge"]')!;
	assert.ok(badge); assert.equal(badge.textContent, "Tests passed");
	assert.equal(badge.style.color, "#123456");
	assert.equal(badge.style.backgroundColor, "color-mix(in oklab, #123456 15%, transparent)");
	assert.equal(badge.hasAttribute("role"), false); assert.equal(badge.hasAttribute("aria-live"), false);
	assert.equal(f.target.querySelector("button"), null, "badges are not controls");
	assert.ok(badge.classList.contains("rounded")); assert.ok(badge.classList.contains("text-xs"));
	await act(async () => { handle.update({ text: '<img src=x onerror="alert(1)">', color: "var(--plugin-accent)" }); });
	assert.ok(f.target.querySelector('[data-slot="status-badge"]') === badge);
	assert.equal(badge.textContent, '<img src=x onerror="alert(1)">'); assert.equal(badge.querySelector("img"), null);
	assert.equal(badge.style.color, "var(--plugin-accent)");
	assert.equal(badge.style.backgroundColor, "color-mix(in oklab, var(--plugin-accent) 15%, transparent)");
	await act(async () => { handle.update({ color: undefined }); });
	assert.equal(badge.style.color ?? "", ""); assert.equal(badge.style.backgroundColor ?? "", "");
	assert.ok(badge.classList.contains("bg-muted")); assert.ok(badge.classList.contains("text-muted-foreground"));
	assert.equal(badge.textContent, '<img src=x onerror="alert(1)">');
	await act(async () => { handle.dispose(); handle.dispose(); });
	assert.equal(f.target.textContent, "caller-owned"); assert.equal(f.store.getSnapshot().length, 0);
}));

it("mountBadge accepts arbitrary text and optional native CSS colors without grading semantics", () => withBadge(async f => {
	for (const color of [undefined, ...colors]) {
		let handle!: PluginWidgetHandle<PluginBadgeProps>;
		await act(async () => { handle = f.ui.mountBadge(f.target, { text: "Any outcome", color }, { signal: f.widget.signal }); });
		assert.deepEqual(f.store.getSnapshot()[0]!.props, { text: "Any outcome", color });
		await act(async () => { handle.dispose(); });
	}
	assert.ok(f.parserCalls.some(([property, value]) => property === "color" && value === "var(--plugin-accent)"));
	assert.ok(f.parserCalls.some(([property, value]) => property === "background-color" && value === "color-mix(in oklab, red 15%, transparent)"));
}));

it("badge validation rejects malformed text/colors and invalid tints atomically on mount and update", () => withBadge(async f => {
	const invalid = [
		{ text: 3 }, { text: null }, { text: document.createElement("span") }, { text: () => "No" },
		{ text: "Invalid", color: null }, { text: "Invalid", color: 42 }, { text: "Invalid", color: "" },
		{ text: "Invalid", color: " " }, { text: "Invalid", color: "not-a-color" },
		{ text: "Invalid", color: "red; position: fixed" }, { text: "Invalid", color: "url(https://example.invalid/x)" },
		{ text: "Invalid", color: "inherit" }, // Valid property keyword, but not a color-mix operand.
	];
	for (const props of invalid) {
		assert.throws(() => f.ui.mountBadge(f.target, props as PluginBadgeProps, { signal: f.widget.signal }), TypeError);
		assert.equal(f.target.textContent, "caller-owned"); assert.equal(f.store.getSnapshot().length, 0);
	}
	let handle!: PluginWidgetHandle<PluginBadgeProps>;
	await act(async () => { handle = f.ui.mountBadge(f.target, { text: "Original", color: "red" }, { signal: f.widget.signal }); });
	const snapshot = f.store.getSnapshot(), badge = f.target.querySelector('[data-slot="status-badge"]');
	for (const props of invalid) {
		assert.throws(() => handle.update(props as PluginBadgeProps), TypeError);
		assert.ok(f.store.getSnapshot() === snapshot); assert.equal(badge!.textContent, "Original");
	}
}));

it("badge widget and plugin lifetime cancellation remove only owned DOM and make later calls inert", () => withBadge(async f => {
	let handle!: PluginWidgetHandle<PluginBadgeProps>;
	await act(async () => { handle = f.ui.mountBadge(f.target, { text: "Pending" }, { signal: f.widget.signal }); });
	await act(async () => { f.widget.abort(); });
	assert.equal(f.target.textContent, "caller-owned"); assert.equal(f.store.getSnapshot().length, 0);
	const count = f.parserCalls.length;
	assert.doesNotThrow(() => handle.update({ text: 42 } as unknown as PluginBadgeProps));
	assert.doesNotThrow(() => f.ui.mountBadge(f.target, { text: 42 } as unknown as PluginBadgeProps, { signal: f.widget.signal }));
	assert.equal(f.parserCalls.length, count);
	await act(async () => { f.ui.mountBadge(f.target, { text: "Owned by plugin" }, { signal: new AbortController().signal }); });
	assert.equal(f.store.getSnapshot().length, 1);
	await act(async () => { f.scope.abort(); });
	assert.equal(f.target.textContent, "caller-owned"); assert.equal(f.store.getSnapshot().length, 0);
	assert.doesNotThrow(() => f.ui.mountBadge(f.target, { text: 42 } as unknown as PluginBadgeProps, { signal: new AbortController().signal }));
}));

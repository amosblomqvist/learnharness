/**
 * Desktop sidebar in a narrow window: Ctrl+B acts on what users see.
 * IS_ELECTRON is read when components/sidebar.tsx is imported, so the
 * Electron user agent is set first and the module is imported after.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
const win = dom.window as unknown as Window & typeof globalThis;
const store = new Map<string, string>();
const expandCalls: number[] = [];
for (const [key, value] of Object.entries({
	window: win,
	document: dom.document,
	CustomEvent: win.CustomEvent,
	navigator: { userAgent: "Mozilla/5.0 Electron/33" },
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(k, v),
	},
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });

const { createRoot } = await import("react-dom/client");
const { SidebarProvider, useSidebar } = await import("../components/sidebar.tsx");
const { kbdEventForAction } = await import("../src/core/keyboard.ts");

const STORAGE_KEY = "lh:sidebar-open";
let visible = false;
function Probe() {
	visible = useSidebar().open;
	return null;
}
let root: ReturnType<typeof createRoot> | undefined;
async function mount() {
	root = createRoot(document.getElementById("root")!);
	await act(async () => root!.render(<SidebarProvider><Probe /></SidebarProvider>));
}
async function unmount() {
	await act(async () => root?.unmount());
	root = undefined;
}
const ctrlB = () => act(async () => { win.dispatchEvent(new win.CustomEvent(kbdEventForAction("toggle-sidebar"))); });
const resizeTo = (width: number) => act(async () => {
	win.innerWidth = width;
	win.dispatchEvent(new win.Event("resize"));
});

beforeEach(() => {
	store.clear();
	expandCalls.length = 0;
	(win as unknown as { lh: unknown }).lh = { platform: "win32", expandWindow: () => expandCalls.push(win.innerWidth) };
});
afterEach(unmount);

test("narrow window, nothing saved: the first Ctrl+B asks to widen and saves open", async () => {
	win.innerWidth = 784;
	await mount();
	assert.equal(visible, false);
	await ctrlB();
	assert.equal(expandCalls.length, 1);
	assert.equal(store.get(STORAGE_KEY), "1");
});

test("narrow window: once the window widens the sidebar shows, and it still shows after a restart", async () => {
	win.innerWidth = 784;
	await mount();
	await ctrlB();
	await resizeTo(928);
	assert.equal(visible, true);
	await unmount();
	await mount();
	assert.equal(visible, true);
});

test("wide window: Ctrl+B hides the sidebar and saves closed", async () => {
	win.innerWidth = 928;
	await mount();
	assert.equal(visible, true);
	await ctrlB();
	assert.equal(visible, false);
	assert.equal(store.get(STORAGE_KEY), "0");
	assert.equal(expandCalls.length, 0);
});

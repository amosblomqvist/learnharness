import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { actionForBinding, eventBinding, loadOverrides } from "../src/core/keyboard.ts";

const { window, document } = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(window, { localStorage: {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => { storage.set(key, value); },
	removeItem: (key: string) => { storage.delete(key); },
} });
Object.assign(globalThis, { window, document });
const roots: { root: Root; host: HTMLElement }[] = [];

async function mount() {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(<KeyboardSection />); });
	return host;
}

async function click(host: HTMLElement, id: string) {
	const button = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert.ok(button);
	await act(async () => { button.click(); });
}

async function press(init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) {
	const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), {
		ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
	});
	await act(async () => { window.dispatchEvent(event); });
	return event;
}

function binding(init: Parameters<typeof press>[0]) {
	return eventBinding({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent);
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
	storage.clear();
});

describe("keyboard rebind shares layout normalization with dispatch", () => {
	it("captures a Russian modified key as an ordinary binding and resets it normally", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-find");
		const event = await press({ key: "л", code: "KeyK", ctrlKey: true, shiftKey: true });
		assert.equal(event.defaultPrevented, true, "capture must not type the layout character");
		assert.deepEqual(loadOverrides(), { find: "mod+shift+k" });
		assert.equal(actionForBinding(binding({ key: "K", code: "KeyK", metaKey: true, shiftKey: true })), "find");
		await click(host, "kbd-reset-find");
		assert.deepEqual(loadOverrides(), {});
		assert.equal(actionForBinding("mod+f"), "find");
	});

	it("captures Alt/Option physical fallback and matches another non-ASCII layout", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-open-model-picker");
		await press({ key: "˚", code: "KeyK", altKey: true });
		assert.deepEqual(loadOverrides(), { "open-model-picker": "alt+k" });
		assert.equal(actionForBinding(binding({ key: "л", code: "KeyK", altKey: true })), "open-model-picker");
		assert.equal(actionForBinding(binding({ key: "k", code: "KeyK", altKey: true })), "open-model-picker");
	});

	it("still ignores modifier-only keydowns, cancels with Escape, and preserves bare rebinds", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-find");
		await press({ key: "Control", code: "ControlLeft", ctrlKey: true });
		assert.deepEqual(loadOverrides(), {});
		assert.ok(host.textContent!.includes("Press keys…"));
		await press({ key: "Escape", code: "Escape" });
		assert.deepEqual(loadOverrides(), {});
		assert.ok(!host.textContent!.includes("Press keys…"));
		await click(host, "kbd-rebind-find");
		await press({ key: "л", code: "KeyK" });
		assert.deepEqual(loadOverrides(), { find: "л" });
	});
});

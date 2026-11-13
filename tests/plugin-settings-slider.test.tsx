import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import type { PluginSettingsSchema, PluginWidgetHandle } from "../src/core/index.ts";

function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function fixture(
	onChange: (value: number, acknowledge: (value: number) => void) => void | Promise<void>,
	run: (f: {
		input: HTMLInputElement;
		change: (value: number) => Promise<void>;
		accepted: () => number;
		disabledMutations: MutationRecord[];
		errors: unknown[];
	}) => Promise<void>,
	options: { disabled?: boolean; validate?: (value: number) => string | undefined } = {},
) {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div><div id='target'></div></body></html>");
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	const globals = {
		window: dom.window, self: dom.window, document: dom.document,
		HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
		Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	// React's native input support must be detected after the fixture DOM exists.
	const { createRoot } = await import("react-dom/client");
	const { createPluginUiStore, PluginUiHost } = await import("../components/plugin-ui-host.tsx");
	const store = createPluginUiStore(), scope = new AbortController(), errors: unknown[] = [];
	const ui = store.createUi({ signal: scope.signal, onError: error => errors.push(error) });
	const root = createRoot(document.querySelector("#root")!);
	let amount = 50, handle!: PluginWidgetHandle<PluginSettingsSchema>;
	const acknowledge = (value: number) => { amount = value; handle.update(schema()); };
	const schema = (): PluginSettingsSchema => ({ rows: [{
		key: "slider", label: "Slider example", type: "slider", value: amount,
		min: 0, max: 100, step: 1, ...options,
		onChange: value => onChange(value, acknowledge),
	}] });
	let observer: MutationObserver | undefined;
	try {
		await act(async () => {
			root.render(<PluginUiHost store={store} />);
			handle = ui.mountSettingsRows(document.querySelector("#target")!, schema(), { signal: scope.signal });
		});
		const input = document.querySelector<HTMLInputElement>('input[type="range"]')!;
		assert.ok(input);
		const disabledMutations: MutationRecord[] = [];
		observer = new dom.window.MutationObserver(records => disabledMutations.push(...records));
		observer.observe(input, { attributes: true, attributeFilter: ["disabled"], attributeOldValue: true });
		await run({
			input, disabledMutations, errors, accepted: () => amount,
			change: async value => { await act(async () => {
				// Bypass React's programmatic-value tracker, like a native edit.
				Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			}); },
		});
	} finally {
		observer?.disconnect();
		await act(async () => { scope.abort(); root.unmount(); });
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}

it("synchronous controlled slider updates retain the native input without any pending-disable mutation", async () => {
	const values: number[] = [];
	await fixture((value, acknowledge) => { values.push(value); acknowledge(value); }, async f => {
		for (const value of [52, 40, 28, 16]) {
			await f.change(value);
			assert.equal(f.accepted(), value);
			assert.equal(f.input.value, String(value));
			assert.equal(f.input.disabled, false);
			assert.equal(document.querySelector('input[type="range"]'), f.input);
			assert.equal(f.input.isConnected, true);
		}
		assert.deepEqual(values, [52, 40, 28, 16]);
		assert.deepEqual(f.disabledMutations, [], "even a transient disabled attribute would cancel native dragging");
		assert.deepEqual(f.errors, []);
	});
});

for (const outcome of ["resolve", "reject"] as const) {
	it(`genuine async slider saves stay disabled and serialized until ${outcome}, then accept another save`, async () => {
		const save = deferred(), failure = new Error("Slider save failed");
		const values: number[] = [];
		await fixture((value, acknowledge) => {
			values.push(value);
			if (values.length === 1) return save.promise.then(() => { acknowledge(value); });
			acknowledge(value);
		}, async f => {
			await f.change(52);
			assert.equal(f.input.disabled, true);
			assert.equal(f.accepted(), 50);
			await f.change(60);
			assert.deepEqual(values, [52], "in-flight saves do not start a concurrent save or queue another value");
			await act(async () => { if (outcome === "resolve") save.resolve(); else save.reject(failure); });
			assert.equal(f.input.disabled, false);
			assert.equal(f.accepted(), outcome === "resolve" ? 52 : 50);
			assert.deepEqual(f.errors, outcome === "resolve" ? [] : [failure]);
			if (outcome === "reject") assert.equal(document.querySelector('[role="alert"]')?.textContent, failure.message);
			await f.change(16);
			assert.deepEqual(values, [52, 16]);
			assert.equal(f.accepted(), 16);
			assert.equal(document.querySelector('[role="alert"]'), null);
		});
	});
}

it("synchronous slider callback failures are reported without disabling the input", async () => {
	const failure = new Error("Synchronous slider failure");
	await fixture(() => { throw failure; }, async f => {
		await f.change(52);
		assert.equal(f.accepted(), 50);
		assert.deepEqual(f.errors, [failure]);
		assert.equal(document.querySelector('[role="alert"]')?.textContent, failure.message);
		assert.deepEqual(f.disabledMutations, []);
	});
});

it("an explicitly disabled slider remains inert for synchronous callbacks", async () => {
	await fixture(() => assert.fail("disabled rows must not persist"), async f => {
		assert.equal(f.input.disabled, true);
		await f.change(16);
		assert.equal(f.accepted(), 50);
		assert.equal(f.input.disabled, true);
		assert.deepEqual(f.errors, []);
	}, { disabled: true });
});

it("slider validation still rejects values before invoking the callback", async () => {
	await fixture(() => assert.fail("invalid values must not persist"), async f => {
		await f.change(51);
		assert.equal(f.accepted(), 50);
		assert.equal(document.querySelector('[role="alert"]')?.textContent, "Choose an even number.");
		assert.deepEqual(f.disabledMutations, []);
	}, { validate: value => value % 2 ? "Choose an even number." : undefined });
});

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createPluginUiStore, PluginUiHost as Host, PluginSettingsRows } from "../components/plugin-ui-host.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
function PluginUiHost(props: React.ComponentProps<typeof Host>) { return <InteractionLayersProvider><Host {...props} /></InteractionLayersProvider>; }
import { createTranscriptDelivery, PluginComposer, PluginStandardComposer } from "../components/plugin-composer.tsx";
import { ModelPickerPill } from "../components/model-picker-pill.tsx";
import { SettingsSlider } from "../components/settings/controls.tsx";
import type { PluginWidgetHandle, PluginButtonProps, PluginSettingsSchema, PluginMenuProps, PluginDialogProps } from "../src/core/plugin-ui.ts";

async function withDom(run: (dom: ReturnType<typeof parseHTML>) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div><div id='target'></div></body></html>");
	const values = {
		window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const restoreModalDom = installModalDom(dom);
	try { await run(dom); }
	finally {
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModalDom();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("controlled plugin UI", () => {
	it("mounts shared buttons through the host, updates callbacks, and disposes only owned DOM", async () => withDom(async (dom) => {
		const store = createPluginUiStore();
		const lifetime = new AbortController(); const scope = new AbortController();
		const ui = store.createUi({ signal: lifetime.signal });
		const target = document.querySelector<HTMLElement>("#target")!;
		target.textContent = "plugin-owned";
		const root = createRoot(document.querySelector("#root")!);
		let first = 0, second = 0;
		let handle!: PluginWidgetHandle<PluginButtonProps>;
		try {
			await act(async () => {
				root.render(<PluginUiHost store={store} />);
				handle = ui.mountButton(target, { label: "First", onClick: () => { first++; } }, { signal: scope.signal });
			});
			assert.equal(target.querySelector("button")?.dataset.slot, "button");
			await act(async () => { target.querySelector("button")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
			assert.equal(first, 1);
			await act(async () => { handle.update({ label: "Second", onClick: () => { second++; } }); });
			assert.equal(target.querySelector("button")!.textContent, "Second");
			await act(async () => { target.querySelector("button")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
			assert.equal(second, 1);
			await act(async () => { scope.abort(); handle.dispose(); handle.update({ label: "Late" }); });
			assert.equal(target.textContent, "plugin-owned"); assert.equal(store.getSnapshot().length, 0);
		} finally { await act(async () => root.unmount()); }
	}));

	it("lifetime abort tears all widgets down and already-aborted scopes never mount", async () => withDom(async () => {
		const store = createPluginUiStore(); const lifetime = new AbortController(); const scope = new AbortController();
		const ui = store.createUi({ signal: lifetime.signal }); const target = document.querySelector<HTMLElement>("#target")!;
		ui.mountButton(target, { label: "One", onClick() {} }, { signal: scope.signal });
		ui.mountButton(target, { label: "Two", onClick() {} }, { signal: scope.signal });
		assert.equal(store.getSnapshot().length, 2);
		lifetime.abort(); assert.equal(store.getSnapshot().length, 0); assert.equal(target.children.length, 0);
		ui.mountButton(target, { label: "Late", onClick() {} }, { signal: scope.signal });
		assert.equal(target.children.length, 0);
	}));

	it("reports rejected callbacks without losing the widget", async () => withDom(async (dom) => {
		const store = createPluginUiStore(); const errors: unknown[] = []; const scope = new AbortController();
		const ui = store.createUi({ signal: scope.signal, onError: (error) => errors.push(error) });
		const root = createRoot(document.querySelector("#root")!); const error = new Error("rejected");
		try {
			await act(async () => { root.render(<PluginUiHost store={store} />); ui.mountButton(document.querySelector("#target")!, { label: "Reject", async onClick() { throw error; } }, { signal: scope.signal }); });
			await act(async () => { document.querySelector("button")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
			assert.deepEqual(errors, [error]); assert.equal(store.getSnapshot().length, 1);
		} finally { await act(async () => { scope.abort(); root.unmount(); }); }
	}));

	it("dialog content gets a mount signal, late cleanup runs exactly once after disposal", async () => withDom(async () => {
		const store = createPluginUiStore(); const lifetime = new AbortController(); const scope = new AbortController();
		const ui = store.createUi({ signal: lifetime.signal }); const root = createRoot(document.querySelector("#root")!);
		let signal!: AbortSignal, cleaned = 0, resolve!: (cleanup: () => void) => void;
		try {
			await act(async () => {
				root.render(<PluginUiHost store={store} />);
				ui.openDialog({ title: "Plugin dialog", content: (target, mountedSignal) => { signal = mountedSignal; target.textContent = "Plugin content"; return new Promise((done) => { resolve = done; }); } }, { signal: scope.signal });
			});
			assert.equal(document.querySelector('[role="dialog"]')?.getAttribute("aria-modal"), "true");
			assert.ok(document.body.textContent?.includes("Plugin content")); assert.equal(signal.aborted, false);
			await act(async () => { scope.abort(); });
			assert.equal(signal.aborted, true); assert.equal(document.querySelector('[role="dialog"]'), null);
			await act(async () => { resolve(() => { cleaned++; }); });
			assert.equal(cleaned, 1);
		} finally { await act(async () => { lifetime.abort(); root.unmount(); }); }
	}));

	it("dialog title is an accessible name only, with edge scrolling and a stationary quiet X", async () => withDom(async () => {
		const store = createPluginUiStore(), scope = new AbortController();
		const ui = store.createUi({ signal: scope.signal }), root = createRoot(document.querySelector("#root")!);
		let handle!: PluginWidgetHandle<PluginDialogProps>;
		let mounted = 0;
		try {
			await act(async () => {
				root.render(<PluginUiHost store={store} />);
				handle = ui.openDialog({ title: "Accessible dialog name", content(container) {
					mounted++;
					const heading = document.createElement("h2"); heading.textContent = "Plugin-owned heading";
					container.append(heading);
				} }, { signal: scope.signal });
			});
			const dialog = document.querySelector('[role="dialog"]')!;
			const frame = document.querySelector<HTMLElement>("[data-plugin-ui-dialog]")!;
			const scroller = frame.querySelector<HTMLElement>("[data-plugin-ui-dialog-scroll]")!;
			const close = frame.querySelector<HTMLElement>('button[aria-label="Close dialog"]')!;
			assert.equal(dialog.getAttribute("aria-label"), "Accessible dialog name");
			assert.deepEqual([...frame.querySelectorAll("h2")].map(heading => heading.textContent), ["Plugin-owned heading"]);
			assert.equal(document.activeElement, frame.querySelector("h2"), "plugin heading remains the initial-focus fallback");
			assert.equal(frame.querySelector("header"), null);
			assert.match(frame.className, /overflow-hidden/); assert.doesNotMatch(frame.className, /overflow-y-auto|p-5/);
			assert.match(scroller.className, /overflow-y-auto p-5/);
			assert.equal(close.parentElement, frame); assert.equal(scroller.contains(close), false);
			assert.equal(close.textContent, ""); assert.ok(close.querySelector("svg"));
			assert.match(close.className, /absolute right-2 top-2.*text-muted-foreground/);
			scroller.scrollTop = 200;
			await act(async () => handle.update({ title: "Updated accessible name" }));
			assert.equal(dialog.getAttribute("aria-label"), "Updated accessible name");
			assert.equal(scroller.scrollTop, 200); assert.equal(mounted, 1);
		} finally { await act(async () => { scope.abort(); root.unmount(); }); }
	}));

	it("held settings controls resolve latest callbacks by key across synchronous reorder/removal", async () => withDom(async (dom) => {
		const store = createPluginUiStore(); const scope = new AbortController();
		const ui = store.createUi({ signal: scope.signal }); const root = createRoot(document.querySelector("#root")!);
		const calls: string[] = [];
		const row = (key: string, version: string): PluginSettingsSchema["rows"][number] => ({
			key, type: "toggle", label: key, value: false, onChange: () => { calls.push(`${key}:${version}`); },
		});
		let handle!: PluginWidgetHandle<PluginSettingsSchema>;
		try {
			await act(async () => {
				root.render(<PluginUiHost store={store} />);
				handle = ui.mountSettingsRows(document.querySelector("#target")!, { rows: [row("A", "old"), row("B", "old")] }, { signal: scope.signal });
			});
			const heldA = document.querySelector<HTMLElement>('[role="switch"][aria-label="A"]')!;
			await act(async () => {
				handle.update({ rows: [row("B", "latest"), row("A", "latest")] });
				heldA.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
			});
			assert.deepEqual(calls, ["A:latest"]);
			await act(async () => {
				handle.update({ rows: [row("B", "after-removal")] });
				heldA.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
			});
			assert.deepEqual(calls, ["A:latest"], "removed A must never invoke B");
		} finally { await act(async () => { scope.abort(); root.unmount(); }); }
	}));

	it("stale menu item callbacks follow key identity and removed items no-op", async () => withDom(async () => {
		const store = createPluginUiStore(); const scope = new AbortController();
		const ui = store.createUi({ signal: scope.signal }); const calls: string[] = [];
		const item = (key: string, version: string) => ({ key, label: key, onSelect: () => { calls.push(`${key}:${version}`); } });
		try {
			const handle = ui.openMenu(document.querySelector("#target")!, { items: [item("A", "old"), item("B", "old")] }, { signal: scope.signal });
			// Retain exactly the protected callback supplied to the old rendered item.
			const oldA = (store.getSnapshot()[0]!.props as PluginMenuProps).items[0]!.onSelect;
			handle.update({ items: [item("B", "latest"), item("A", "latest")] });
			await oldA(); assert.deepEqual(calls, ["A:latest"]);
			handle.update({ items: [item("B", "after-removal")] });
			await oldA(); assert.deepEqual(calls, ["A:latest"]);
		} finally { scope.abort(); }
	}));

	for (const dismissal of ["Escape", "backdrop", "button"] as const) {
		it(`dialog ${dismissal} uses an added/latest onClose exactly once without refocusing on update`, async () => withDom(async (dom) => {
			const store = createPluginUiStore(); const scope = new AbortController();
			const ui = store.createUi({ signal: scope.signal }); const root = createRoot(document.querySelector("#root")!);
			let handle!: PluginWidgetHandle<PluginDialogProps>; let closed = 0, refocused = 0;
			try {
				await act(async () => {
					root.render(<PluginUiHost store={store} />);
					handle = ui.openDialog({ title: "Mutable dialog", content: document.createElement("div") }, { signal: scope.signal });
				});
				const frame = document.querySelector<HTMLElement>('[data-plugin-ui-dialog]')!;
				frame.focus = () => { refocused++; };
				await act(async () => { handle.update({ onClose: () => { closed++; } }); });
				assert.equal(refocused, 0, "controlled callback updates must not reset dialog focus");
				const dispatch = (target: EventTarget, type: string, fields = {}) => {
					const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
					Object.assign(event, fields); target.dispatchEvent(event);
				};
				await act(async () => {
					if (dismissal === "Escape") {
						dispatch(document, "keydown", { key: "Escape" });
						dispatch(document, "keydown", { key: "Escape" });
					} else if (dismissal === "backdrop") {
						const backdrop = frame.parentElement!;
						for (let count = 0; count < 2; count++) {
							for (const type of ["pointerdown", "pointerup", "click"]) dispatch(backdrop, type, { pointerId: 1, button: 0, isPrimary: true });
						}
					} else {
						const button = frame.querySelector("button")!;
						dispatch(button, "click"); dispatch(button, "click");
					}
				});
				assert.equal(closed, 1); assert.equal(document.querySelector('[role="dialog"]'), null);
			} finally { await act(async () => { scope.abort(); root.unmount(); }); }
		}));
	}

	it("neutral composer reuses core renderer without file routing or practice affordances", () => {
		const html = renderToStaticMarkup(<PluginComposer value="" onChange={() => {}} onSend={() => {}} />);
		assert.match(html, /data-testid="composer"/);
		assert.match(html, /Message…/);
		assert.doesNotMatch(html, /data-file-path-input|data-file-path-default|Next problem|Ask, answer|Usage/);
	});

	it("shared model/thinking triggers own their canonical chrome typography", () => {
		const { document } = parseHTML(renderToStaticMarkup(<ModelPickerPill>Fixture model</ModelPickerPill>));
		const trigger = document.querySelector("button")!;
		for (const token of ["font-ui", "text-xs"]) assert.ok(trigger.classList.contains(token), token);
		assert.equal(trigger.querySelector("span")!.className, "text-card-foreground", "label color stays native foreground");
		assert.equal(trigger.querySelector("[aria-hidden]")!.className, "text-xs text-muted-foreground");
	});

	it("standard composer keeps only the input row inside the frame and controls below it", () => {
		const html = renderToStaticMarkup(<InteractionLayersProvider><PluginStandardComposer
			composer={{ value: "", autoFocus: false, onChange() {}, onSend() {} }}
			model={{ value: undefined, onChange() {} }}
			thinking={{ model: undefined, value: undefined, onChange() {} }}
			dictation={{ onTranscript() {} }}
		/></InteractionLayersProvider>);
		const { document } = parseHTML(html);
		const preset = document.querySelector("[data-plugin-standard-composer]")!;
		const frame = preset.children[0]!, controls = preset.children[1]!;
		assert.equal(preset.children.length, 2);
		assert.ok(!preset.classList.contains("border"));
		for (const token of ["rounded-2xl", "border", "bg-card", "shadow-lg"]) assert.ok(frame.classList.contains(token), token);
		assert.ok(frame.querySelector('[data-testid="composer"]'));
		assert.equal(frame.querySelector("[data-testid=plugin-dictation-control], [data-plugin-model-picker], [data-plugin-thinking-picker]"), null);
		for (const selector of ["[data-testid=plugin-dictation-control]", "[data-plugin-model-picker]", "[data-plugin-thinking-picker]"]) assert.ok(controls.querySelector(selector), selector);
		for (const token of ["font-ui", "text-xs", "text-muted-foreground", "pt-2"]) assert.ok(controls.classList.contains(token), token);
		assert.equal(controls.querySelector('[data-testid="composer"]'), null);
		assert.ok(document.querySelector('button[aria-label="Send"]')!.hasAttribute("disabled"));
		assert.doesNotMatch(html, /data-file-path-input|data-file-path-default|Next problem|Usage/);
	});

	it("schema rows reuse the shared settings controls with controlled values", () => {
		const html = renderToStaticMarkup(<PluginSettingsRows schema={{ rows: [
			{ key: "enabled", label: "Enabled", type: "toggle", value: true, onChange() {} },
			{ key: "count", label: "Count", type: "number", value: 4, min: 1, max: 10, onChange() {} },
			{ key: "mode", label: "Mode", type: "dropdown", value: "a", options: [{ value: "a", label: "Alpha" }], onChange() {} },
			{ key: "size", label: "Size", type: "slider", value: 2, min: 0, max: 3, onChange() {} },
		] }} />);
		assert.match(html, /role="switch"/); assert.match(html, /aria-checked="true"/);
		assert.match(html, /type="number"[^>]*min="1"[^>]*max="10"/);
		assert.match(html, /<select/); assert.match(html, /type="range" aria-label="Size"/);
		assert.equal((html.match(/>Size</g) ?? []).length, 1, "the schema slider has only one visible label");
	});

	it("shared slider keeps its standalone graph label by default", () => {
		const html = renderToStaticMarkup(<SettingsSlider label="Graph size" value={2} onChange={() => {}} />);
		assert.match(html, />Graph size</); assert.match(html, /type="range" aria-label="Graph size"/);
	});

	it("flush-before-send waits for asynchronous transcript delivery", async () => {
		const delivery = createTranscriptDelivery(); let resolve!: () => void; let text = "", sent = "";
		const ready = new Promise<void>((done) => { resolve = done; });
		let finished = false;
		const sending = delivery.finish(async () => {
			delivery.append(async () => { await ready; text = "spoken text"; }, (error) => { throw error; });
		}, () => { sent = text; finished = true; });
		await Promise.resolve(); assert.equal(finished, false); resolve(); await sending;
		assert.equal(sent, "spoken text");
	});

	it("failed transcript delivery is reported and does not submit stale text", async () => {
		const delivery = createTranscriptDelivery(); const errors: unknown[] = []; let sent = false;
		await assert.rejects(delivery.finish(async () => {
			await delivery.append(async () => { throw new Error("not stored"); }, (error) => errors.push(error));
		}, () => { sent = true; }), /not stored/);
		assert.equal(errors.length, 1); assert.equal(sent, false);
	});

	it("append returns the delivery promise so the dictation engine observes completion and rejection", async () => {
		const delivery = createTranscriptDelivery(); const errors: unknown[] = [];
		let resolve!: () => void;
		const callbackResult = new Promise<void>((done) => { resolve = done; });
		const result = delivery.append(() => callbackResult, (error) => errors.push(error));
		assert.equal(result, callbackResult, "the engine receives the actual callback promise");
		resolve(); await result;
		const failed = new Error("transcript failed");
		await assert.rejects(delivery.append(() => Promise.reject(failed), (error) => errors.push(error)), (error) => error === failed);
		await assert.rejects(delivery.append(() => { throw failed; }, (error) => errors.push(error)), (error) => error === failed);
		assert.deepEqual(errors, [failed, failed]);
	});
});

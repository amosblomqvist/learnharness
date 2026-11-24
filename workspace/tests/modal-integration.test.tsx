import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { DeleteSourceDialog } from "../components/delete-source-dialog.tsx";
import { DeleteSessionDialog } from "../components/delete-session-dialog.tsx";
import { DeleteNodeDialog } from "../components/delete-node-dialog.tsx";
import { AbortTurnDialog } from "../components/abort-turn-dialog.tsx";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { createPluginUiStore, PluginUiHost } from "../components/plugin-ui-host.tsx";
import { ChatGPTConnection, ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { NativeSubscriptionConnection, NativeSubscriptionUIProvider, emptySubscriptionStatus } from "../components/settings/subscription-connections.tsx";
import type { ChatGPTStatus } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

let root: Root | undefined, restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div><button id='launcher'>Launch</button></body></html>");
	const globals = { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	restore = () => {
		restoreModalDom();
		for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
	};
	root = createRoot(document.querySelector("#root")!);
	let controller!: InteractionLayersController;
	function Probe() { controller = useInteractionLayers(); return null; }
	return {
		dom,
		controller: () => controller,
		async render(children: React.ReactNode) { await act(async () => root!.render(<InteractionLayersProvider><Probe />{children}</InteractionLayersProvider>)); },
		async escape(target: EventTarget = document) {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key: "Escape" });
			await act(async () => { controller.captureKeyDown(event as unknown as KeyboardEvent); target.dispatchEvent(event); });
			return event;
		},
	};
}
const byTest = (id: string) => { const node = document.querySelector<HTMLElement>(`[data-testid='${id}']`); assert(node, `missing ${id}`); return node; };
async function click(node: HTMLElement) { await act(async () => node.click()); }
afterEach(async () => {
	await act(async () => root?.unmount()); root = undefined;
	await new Promise(resolve => setTimeout(resolve, 5));
	restore?.(); restore = undefined; globalThis.fetch = originalFetch;
});

for (const kind of ["source", "session", "node"] as const) it(`${kind} deletion blocks and consumes Escape/return-to while accepted deletion is busy`, async () => {
	const f = fixture(), deletion = deferred<void>();
	let childClosed = 0, parentClosed = 0;
	globalThis.fetch = async () => { await deletion.promise; return Response.json({ ok: true, graphRevision: 1 }); };
	function Harness() {
		const [open, setOpen] = React.useState(true);
		const close = () => { childClosed++; setOpen(false); };
		return <HostDialog open layerId="parent" onClose={() => { parentClosed++; return "closed"; }}><h2>Parent</h2>
			{kind === "source" ? <DeleteSourceDialog open={open} sources={[]} folders={[]} onClose={close} onDelete={() => deletion.promise} />
				: kind === "session" ? <DeleteSessionDialog chat={open ? { id: "fixture", title: "Fixture session" } : null} onClose={close} onDeleted={close} />
					: <DeleteNodeDialog nodes={open ? [{ id: "fixture", name: "Fixture node" }] : null} onClose={close} onDeleted={close} />}
		</HostDialog>;
	}
	await f.render(<Harness />);
	const heading = byTest(`delete-${kind}-dialog`).querySelector("h2");
	assert.equal(document.activeElement, heading, "confirmations focus their heading, not an action or checkbox");
	await click(byTest(kind === "source" ? "source-delete-confirm" : kind === "session" ? "delete-confirm" : "node-delete-confirm"));
	const event = await f.escape();
	assert.equal(event.defaultPrevented, true); assert.equal(childClosed, 0); assert.equal(parentClosed, 0);
	assert.equal(f.controller().popTo("parent"), "blocked");
	assert.equal((byTest(kind === "source" ? "source-delete-cancel" : kind === "session" ? "delete-cancel" : "node-delete-cancel") as HTMLButtonElement).disabled, true);
	await act(async () => deletion.resolve());
	assert.equal(childClosed, 1); assert.equal(parentClosed, 0);
});

it("abort confirmation busy is informational and does not lock dismissal", async () => {
	const f = fixture(); let closed = 0;
	function Harness() {
		const [open, setOpen] = React.useState(true);
		return <AbortTurnDialog mode={open ? "question" : null} busy onClose={() => { closed++; setOpen(false); }} onConfirm={() => assert.fail("dismiss must not confirm")} />;
	}
	await f.render(<Harness />);
	assert.equal(document.activeElement, byTest("abort-turn-title"));
	assert.equal((byTest("abort-turn-cancel") as HTMLButtonElement).disabled, false);
	await f.escape(); assert.equal(closed, 1); assert.equal(document.querySelector('[role="dialog"]'), null);
});

it("setup remains dismissible while saving without cancelling its accepted settings write", async () => {
	const f = fixture(), write = deferred<Response>(); let closed = 0, completed = 0, writes = 0;
	const model = { provider: "fixture", id: "fixture-model", name: "Fixture", input: ["text", "image"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	globalThis.fetch = async (input, init) => {
		if (init?.method === "PUT") { assert.equal(String(input), "/api/settings/models"); writes++; return write.promise; }
		return String(input) === "/api/keys" ? Response.json({ providers: [] }) : Response.json({ providers: [{ id: "fixture", keyPresent: true }], models: [model], slots: Object.fromEntries(["strong", "cheap", "vision"].map(slot => [slot, { model: { provider: model.provider, id: model.id } }])) });
	};
	function Harness() { const [open, setOpen] = React.useState(true); return <SetupDialog open={open} onClose={() => { closed++; setOpen(false); }} onDone={() => { completed++; }} />; }
	await f.render(<Harness />); await click(byTest("setup-save"));
	assert.equal(writes, 1); assert.equal((byTest("setup-save") as HTMLButtonElement).disabled, true);
	await f.escape(); assert.equal(closed, 1); assert.equal(document.querySelector("[data-testid='setup-dialog']"), null);
	await act(async () => write.resolve(Response.json({ ok: true })));
	assert.equal(completed, 1); assert.equal(writes, 1);
});

it("public plugin dialog updates and child coverage preserve content mount/signal/scroll, and leaf Escape wins", async () => {
	const f = fixture(), store = createPluginUiStore(), lifetime = new AbortController();
	const ui = store.createUi({ signal: lifetime.signal });
	let mounted = 0, cleaned = 0, closed = 0, signal!: AbortSignal;
	await f.render(<PluginUiHost store={store} />);
	let parent!: ReturnType<typeof ui.openDialog>, child!: ReturnType<typeof ui.openDialog>;
	await act(async () => {
		parent = ui.openDialog({ title: "Parent", content: (target, nextSignal) => {
			mounted++; signal = nextSignal;
			const input = document.createElement("input"); input.setAttribute("data-testid", "plugin-leaf"); input.value = "retained";
			input.addEventListener("keydown", event => { if (event.key === "Escape") event.preventDefault(); });
			target.append(input); return () => { cleaned++; };
		}, onClose: () => { closed++; } }, { signal: lifetime.signal });
	});
	const frame = document.querySelector<HTMLElement>("[data-plugin-ui-dialog]")!; frame.scrollTop = 37;
	const field = byTest("plugin-leaf");
	await f.escape(field); assert.equal(closed, 0); assert.equal(mounted, 1);
	await act(async () => { parent.update({ title: "Updated parent" }); child = ui.openDialog({ title: "Child", content: document.createElement("div") }, { signal: lifetime.signal }); });
	assert.equal(mounted, 1); assert.equal(cleaned, 0); assert.equal(signal.aborted, false);
	assert.equal(frame.isConnected, true); assert.notEqual(frame.style.display, "none"); assert.equal(frame.hidden, false);
	assert.equal(frame.scrollTop, 37); assert.equal(frame.closest("[data-interaction-layer]")?.hasAttribute("inert"), true);
	assert.equal(f.controller().isElementEligible(field), false);
	await f.escape(); assert.equal(closed, 0); assert.equal(mounted, 1); assert.equal(cleaned, 0);
	assert.equal(frame.closest("[data-interaction-layer]")?.hasAttribute("inert"), false);
	await act(async () => { child.dispose(); parent.dispose(); });
	assert.equal(cleaned, 1); assert.equal(signal.aborted, true); assert.equal(closed, 0, "external disposal does not synthesize close");
});

it("public plugin menu belongs to its portaled modal anchor, reports errors, and waits for selection success", async () => {
	const f = fixture(), store = createPluginUiStore(), lifetime = new AbortController(), selected = deferred<void>();
	const errors: unknown[] = [], failure = new Error("fixture failure");
	const ui = store.createUi({ signal: lifetime.signal, onError: error => errors.push(error) });
	await f.render(<PluginUiHost store={store} />);
	const anchor = document.createElement("button"); anchor.textContent = "Anchor";
	let menuClosed = 0, dialogClosed = 0;
	await act(async () => { ui.openDialog({ title: "Parent", content: anchor, onClose: () => { dialogClosed++; } }, { signal: lifetime.signal }); });
	const modal = f.controller().getActiveModal()!;
	await act(async () => { ui.openMenu(anchor, { items: [{ key: "fail", label: "Fail", onSelect: async () => { throw failure; } }, { key: "wait", label: "Wait", onSelect: () => selected.promise }], onClose: () => { menuClosed++; } }, { signal: lifetime.signal }); });
	const menu = byTest("plugin-menu");
	assert.equal(f.controller().getTopLayer()?.ownerId, modal.id);
	assert.equal(menu.closest("[data-interaction-layer]"), modal.rootRef.current);
	await click(menu.querySelectorAll<HTMLButtonElement>("button")[0]!);
	assert.deepEqual(errors, [failure]); assert.equal(menu.isConnected, true); assert.equal(menuClosed, 0);
	await click(menu.querySelectorAll<HTMLButtonElement>("button")[1]!);
	assert.equal(menu.isConnected, true); assert.equal(menuClosed, 0);
	await act(async () => selected.resolve()); assert.equal(menuClosed, 1); assert.equal(menu.isConnected, false);
	await act(async () => { ui.openMenu(anchor, { items: [], onClose: () => { menuClosed++; } }, { signal: lifetime.signal }); });
	await f.escape(); assert.equal(menuClosed, 2); assert.equal(dialogClosed, 0); assert.equal(document.activeElement, anchor);
	await f.escape(); assert.equal(dialogClosed, 1);
});

for (const provider of ["chatgpt", "native"] as const) it(`${provider} return-to stops at confirmation-back, pending cancellation, and busy refusal`, async () => {
	const f = fixture(), cancellation = deferred<void>();
	let cancelCalls = 0;
	const listeners = new Set<() => void>();
	let status: ChatGPTStatus = { available: true, pending: false, allowBackgroundUse: true, activeId: "fixture", accounts: [{ id: "fixture", email: "fixture@example.invalid", registration: "fixture", connected: true }], error: null };
	const native = { ...emptySubscriptionStatus("xai"), available: true, connected: true, connectionId: "fixture" };
	window.lh = { expandWindow() {}, chatgpt: {
		status: async () => status, onChange: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
		cancel: async () => { cancelCalls++; await cancellation.promise; status = { ...status, pending: false }; return status; },
		login: async () => status, select: async () => status, disconnect: async () => status, consent: async () => status, logout: async () => status,
	}, subscriptions: {
		status: async () => [native], onChange: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
		cancel: async () => { cancelCalls++; await cancellation.promise; native.pending = false; },
		login: async () => {}, consent: async () => {}, disconnect: async () => {}, retry: async () => {}, respond: async () => {}, open: async () => {},
	} };
	const button = (text: string) => { const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text); assert(node, `missing ${text}`); return node; };
	await f.render(<HostDialog open layerId="settings" onClose={() => assert.fail("must not close target")}><h2>Settings</h2>
		{provider === "chatgpt" ? <ChatGPTUIProvider><ChatGPTConnection /></ChatGPTUIProvider> : <NativeSubscriptionUIProvider><NativeSubscriptionConnection providerId="xai" /></NativeSubscriptionUIProvider>}
	</HostDialog>);
	await click(button("Manage…")); await click(button("Disconnect"));
	let result: string | undefined;
	await act(async () => { result = f.controller().popTo("settings"); });
	assert.equal(result, "handled-without-close"); assert.equal(cancelCalls, 0); assert.equal(f.controller().getSnapshot().length, 2);
	status = { ...status, pending: true }; native.pending = true;
	await act(async () => { for (const listener of listeners) listener(); });
	await act(async () => { result = f.controller().popTo("settings"); });
	assert.equal(result, "pending"); assert.equal(cancelCalls, 1); assert.equal(f.controller().getSnapshot().length, 2);
	await act(async () => { result = f.controller().popTo("settings"); });
	assert.equal(result, "blocked"); assert.equal(cancelCalls, 1);
	await act(async () => cancellation.resolve());
	assert.equal(f.controller().getSnapshot().length, 1);
	delete window.lh;
});

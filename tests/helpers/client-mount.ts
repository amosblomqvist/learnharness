/** Client-mounted component tests under linkedom: the mount, and typing the way a user does. */
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { parseHTML } from "linkedom";

/**
 * Mounts `node` on the client in a fresh linkedom document, installed as the
 * browser globals until `unmount` restores the previous ones (and linkedom's
 * own prototypes, which every document shares). Observers are inert, and so
 * are animation frames unless `frames` runs each one on the next task, for
 * `settle` to wait out. `fetch` defaults to a request that never settles, so
 * a component keeps the state it mounted with.
 */
export async function mountClient(node: ReactNode, { fetch: fetchStub = () => new Promise<Response>(() => {}), frames = false }: { fetch?: typeof fetch; frames?: boolean } = {}) {
	const { window: win, document: doc } = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	Object.assign(doc, { oninput: null });
	const undo: (() => void)[] = [];
	const patch = (target: object, name: string, descriptor: PropertyDescriptor) => {
		const before = Object.getOwnPropertyDescriptor(target, name);
		Object.defineProperty(target, name, { configurable: true, ...descriptor });
		undo.push(() => (before ? Object.defineProperty(target, name, before) : delete (target as Record<string, unknown>)[name]));
	};
	const stored = new Map<string, string>();
	const pendingFrames = new Set<ReturnType<typeof setImmediate>>();
	const requestFrame = (callback: FrameRequestCallback) => {
		if (!frames) return 0;
		const id = setImmediate(() => {
			pendingFrames.delete(id);
			callback(performance.now());
		});
		pendingFrames.add(id);
		return id;
	};
	const cancelFrame = (id: ReturnType<typeof setImmediate>) => {
		pendingFrames.delete(id);
		clearImmediate(id);
	};
	const browser: Record<string, unknown> = {
		window: win, self: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node,
		HTMLInputElement: win.HTMLInputElement, Event: win.Event, CustomEvent: win.CustomEvent, MutationObserver: win.MutationObserver,
		IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchStub, location: new URL("http://localhost/"),
		getComputedStyle: (element: HTMLElement) => element.style,
		localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) },
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
	};
	for (const [name, value] of Object.entries(browser)) patch(globalThis, name, { writable: true, value });
	patch(win.HTMLElement.prototype, "getAnimations", { value: () => [] });
	patch(win.HTMLElement.prototype, "scrollIntoView", { value: () => {} });
	// linkedom has no layout: every box measures zero.
	for (const box of ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"]) patch(win.HTMLElement.prototype, box, { get: () => 0 });
	patch(win.HTMLInputElement.prototype, "select", { value: () => {} });
	// A browser reports an input with no type attribute as a text field, which
	// React needs to fire its onChange; linkedom reports null.
	const type = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "type")!;
	patch(win.HTMLInputElement.prototype, "type", { get(this: HTMLInputElement) { return type.get!.call(this) ?? "text"; }, set: type.set });
	// A canvas draws into a context, and paths, that accept every call and
	// measure as zero.
	const inert: object = new Proxy(function () {}, {
		get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : inert),
		apply: () => inert,
		construct: () => inert,
	});
	patch(win.HTMLCanvasElement.prototype, "getContext", { value: () => inert });
	patch(globalThis, "Path2D", { writable: true, value: inert });
	// Imported only now: React DOM reads the document's events once, on first import.
	const { createRoot } = await import("react-dom/client");
	const host = doc.getElementById("root")!;
	const root = createRoot(host);
	await act(async () => root.render(node));
	return {
		host,
		/** Renders `next` in place of the mounted node, as a parent's re-render would. */
		async render(next: ReactNode) {
			await act(async () => root.render(next));
		},
		/** Runs tasks until no animation frame is pending. */
		async settle() {
			for (let task = 0; task < 1000 && (task === 0 || pendingFrames.size > 0); task++) {
				await act(async () => new Promise((resolve) => setImmediate(resolve)));
			}
			assert.equal(pendingFrames.size, 0, "the frames never came to rest");
		},
		async unmount() {
			await act(async () => root.unmount());
			for (const restore of undo.reverse()) restore();
		},
	};
}

/** Types `value` into a plain input the way the browser does: the native setter, then an `input` event. */
export async function typeInto(input: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

/** Types `value` into a `PathInput` editor: its text, then an `input` event. */
export async function typeIntoEditor(editor: HTMLElement, value: string) {
	await act(async () => {
		editor.textContent = value;
		editor.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { SessionWorkspace } from "../components/workspace/session-workspace";
import type { WorkspaceState } from "../components/workspace/pane-context";

test("workspace observes its new root after Settings and responds to wide and narrow widths", async () => {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const observers: ObservedSize[] = [];
	class ObservedSize {
		element: Element | null = null;
		disconnected = false;
		constructor(private readonly callback: ResizeObserverCallback) { observers.push(this); }
		observe(element: Element) { this.element = element; }
		disconnect() { this.disconnected = true; }
		emit(width: number) {
			assert.ok(!this.disconnected && this.element?.isConnected);
			this.callback([{ target: this.element, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
		}
	}
	const state: WorkspaceState = {
		id: "test-window", activePaneId: "left", split: .5, views: {}, keyboardOverrides: null,
		panes: [{ id: "left", sessionId: "first" }, { id: "right", sessionId: "second" }],
	};
	Object.defineProperty(win, "location", { configurable: true, value: { pathname: "/settings", search: "" } });
	Object.defineProperty(win, "lh", { configurable: true, value: { workspace: { get: async () => state, onChanged: () => () => {} } } });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		Node: win.Node, ResizeObserver: ObservedSize, IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
		// Leave record requests pending so this fixture tests the workspace
		// lifecycle without loading the chat's unrelated model/provider UI.
		fetch: () => new Promise<Response>(() => {}),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	const draw = async (pathname: string) => {
		await act(async () => { root.render(<PathnameContext.Provider value={pathname}><SessionWorkspace><p>Settings fallback</p></SessionWorkspace></PathnameContext.Provider>); });
	};
	const checkWidths = async (observer: ObservedSize) => {
		await act(async () => { observer.emit(1800); });
		assert.equal(doc.querySelector('[data-testid="pane-switcher"]'), null);
		const panes = [...doc.querySelectorAll<HTMLElement>("[data-workspace-pane]")];
		assert.equal(panes.length, 2);
		assert.ok(panes.every(pane => pane.parentElement!.style.display === "flex"));
		await act(async () => { observer.emit(900); });
		assert.ok(doc.querySelector('[data-testid="pane-switcher"]'));
		assert.equal(panes.filter(pane => pane.parentElement!.style.display === "none").length, 1);
	};
	try {
		await draw("/settings");
		assert.equal(observers.length, 0);
		await draw("/");
		assert.equal(observers.length, 1);
		const first = observers[0]!;
		await checkWidths(first);
		await draw("/settings");
		assert.equal(first.disconnected, true);
		assert.equal(doc.querySelector('[data-testid="session-workspace"]'), null);
		await draw("/");
		assert.equal(observers.length, 2);
		const second = observers[1]!;
		assert.notEqual(first.element, second.element);
		await checkWidths(second);
	} finally {
		await act(async () => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
});

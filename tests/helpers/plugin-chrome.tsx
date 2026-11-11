import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PluginsProvider, createPluginWindowOwner } from "../../components/plugins.tsx";
import { ServerEventsProvider, type NotifySource } from "../../components/server-events.tsx";
import type { PluginFrontendModule, PluginInfo } from "../../src/core/plugins.ts";
import { InteractionLayersProvider } from "../../components/interaction-layers.tsx";
import { installModalDom } from "../modal-dom.ts";

export const pluginInfo = (id = "fixture"): PluginInfo => ({
	id, origin: "community", enabled: true, status: "active", revision: "fixture-1",
	manifest: { apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.4.1", main: "main.js" },
});

/** In-memory plugins/fetch only: never opens a real data directory or provider. */
export async function mountPluginChrome(frontend: PluginFrontendModule, children: ReactNode, { strictMode = false }: { strictMode?: boolean } = {}) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const globals = {
		window: dom.window, self: dom.window, document: dom.document, innerWidth: 900, innerHeight: 700,
		HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
		HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
		getComputedStyle: (element: HTMLElement) => ({
			columnGap: element.tagName === "HEADER" ? "12" : "4", paddingLeft: "12", paddingRight: "12",
			flexGrow: element.className.includes("flex-1") ? "1" : "0", minWidth: "16", marginLeft: "0", marginRight: "0",
			getPropertyValue: () => "", display: "block", visibility: "visible",
		}),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
		fetch: async () => { throw new Error("No real requests in chrome fixtures"); },
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	// Chrome measurement keeps its fixture-specific geometry; modal shims
	// still supply focus, legacy-input, traversal and event support.
	Object.assign(globalThis, { getComputedStyle: globals.getComputedStyle });
	Object.assign(dom.window, { getComputedStyle: globals.getComputedStyle });
	Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 900, writable: true });
	Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 700, writable: true });
	let width = 900;
	Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return width; } });
	Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.hasAttribute("data-plugin-chrome-title") ? 200 : 80; } });
	dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
		const w = this.className.includes("h-9") ? 80 : 36;
		return { top: 0, bottom: 36, left: 0, right: w, width: w, height: 36, x: 0, y: 0, toJSON() {} };
	};
	const owner = createPluginWindowOwner({
		fetch: async () => Response.json({ plugins: [pluginInfo()], directory: "/in-memory-plugins" }),
		importModule: async () => frontend, pathname: () => "/plugins/fixture/overview", navigate() {},
	});
	window.__lhPluginWindow = owner;
	const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const root = createRoot(document.querySelector("#root")!);
	const render = async (content: ReactNode) => {
		const tree = <InteractionLayersProvider><AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>{content}</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider></InteractionLayersProvider>;
		await act(async () => { root.render(strictMode ? <React.StrictMode>{tree}</React.StrictMode> : tree); });
	};
	try { await render(children); }
	catch (error) {
		await act(async () => { root.unmount(); });
		await new Promise(resolve => setTimeout(resolve, 5));
		restore(); throw error;
	}
	function restore() {
		restoreModalDom();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
	return {
		document: dom.document, owner, render,
		async resize(value: number) { width = value; Object.defineProperty(dom.window, "innerWidth", { configurable: true, value }); await act(async () => { window.dispatchEvent(new dom.window.Event("resize")); }); },
		async click(element: HTMLElement) { await act(async () => { element.dispatchEvent(new dom.window.Event("click", { bubbles: true })); }); },
		async close() {
			await act(async () => { root.unmount(); });
			// FocusScope's delayed unmount event still needs the fixture DOM.
			await new Promise(resolve => setTimeout(resolve, 5));
			restore();
		},
	};
}

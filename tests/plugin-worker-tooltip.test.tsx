import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { installModalDom } from "./modal-dom.ts";

// Popper chooses its browser layout effect at import time, just as in the
// existing passive-tooltip fixture. Each test still gets its own isolated DOM.
const bootstrap = parseHTML("<html><body></body></html>");
const bootstrapSaved = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.document });
const { PluginWorkerResultSurface } = await import("../components/plugin-worker-result.tsx");
const { TOOLTIP_DELAY_MS } = await import("../components/ui/tooltip.tsx");
for (const [key, descriptor] of bootstrapSaved) {
	if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
}

async function fixture(run: (f: {
	render: (children: React.ReactNode) => Promise<void>;
	pointer: (target: Element, type: string) => Promise<void>;
	advance: (ms: number) => Promise<void>;
}) => Promise<void>) {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	const globals = {
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
		SVGElement: dom.window.SVGElement, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	const proto = dom.window.HTMLElement.prototype;
	const geometry = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
	Object.defineProperty(proto, "getBoundingClientRect", { configurable: true, value() {
		return { left: 100, top: 100, right: 180, bottom: 124, width: 80, height: 24, x: 100, y: 100, toJSON() {} };
	} });
	const style = (element: HTMLElement) => ({
		display: "block", visibility: "visible", position: "static", direction: "ltr", width: "80px", height: "24px",
		overflow: "visible", overflowX: "visible", overflowY: "visible", transform: "none", perspective: "none", filter: "none",
		backdropFilter: "none", contain: "none", willChange: "auto", boxSizing: "border-box", animationName: "none",
		paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
		getPropertyValue: (key: string) => element.style.getPropertyValue(key),
	});
	const extra = {
		getComputedStyle: style, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	};
	const savedExtra = new Map(Object.keys(extra).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, extra); Object.assign(dom.window, { getComputedStyle: style });
	mock.timers.enable({ apis: ["setTimeout"] });
	const root = createRoot(document.querySelector("#root")!);
	try {
		await run({
			render: async children => { await act(async () => { root.render(children); }); },
			pointer: async (target, type) => { await act(async () => {
				const event = new dom.window.Event(type, { bubbles: true });
				Object.assign(event, { pointerType: "mouse", relatedTarget: document.body, clientX: 140, clientY: 112 });
				target.dispatchEvent(event);
			}); },
			advance: async ms => { await act(async () => { mock.timers.tick(ms); }); },
		});
	} finally {
		await act(async () => { root.unmount(); mock.timers.tick(0); });
		mock.timers.reset();
		if (geometry) Object.defineProperty(proto, "getBoundingClientRect", geometry); else Reflect.deleteProperty(proto, "getBoundingClientRect");
		for (const [key, descriptor] of savedExtra) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
		restoreModal();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}

for (const presentation of ["collapsed", "card", "plain"] as const) {
	it(`${presentation} worker outcome uses the application's delayed DOM tooltip without adding controls`, async () => fixture(async f => {
		for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
			await f.render(<PluginWorkerResultSurface key={status} label="Example worker" status={status} presentation={presentation} text="Fixture result" />);
			const header = document.querySelector<HTMLElement>('[data-testid="plugin-worker-header"]')!;
			assert.equal(header.getAttribute("data-slot"), "tooltip-trigger");
			assert.equal(header.getAttribute("title"), null);
			assert.equal(header.getAttribute("tabindex"), null);
			assert.equal(document.querySelector("button"), null);
			if (presentation === "collapsed") assert.equal(document.querySelector("details")?.firstElementChild, header);
			assert.equal(document.querySelector('[role="tooltip"]'), null);
			await f.pointer(header, "pointermove");
			await f.advance(TOOLTIP_DELAY_MS - 1);
			assert.equal(document.querySelector('[role="tooltip"]'), null, "normal application hover delay is preserved");
			await f.advance(1);
			const tooltip = document.querySelector('[role="tooltip"][data-slot="tooltip-content"]')!;
			assert.ok(tooltip, "outcome is exposed in actual styled tooltip DOM, not only a title attribute");
			assert.equal(tooltip.textContent, `Example worker: ${status}`);
			assert.equal(header.getAttribute("aria-describedby"), tooltip.id);
			assert.equal(header.querySelector(".sr-only")?.textContent, ` ${status}`);
			if (presentation === "collapsed") assert.equal(document.querySelector("details")?.firstElementChild, header);
			await f.pointer(header, "pointerout");
			assert.equal(document.querySelector('[role="tooltip"]'), null);
		}
	}));
}

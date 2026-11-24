import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { usePlanLayout } from "../components/plan-block.tsx";

const plan = {
	nodes: [{ id: "a", title: "Alpha", status: "current" }, { id: "b", title: "Beta", status: "upcoming" }],
	edges: [{ from: "a", to: "b" }],
};

test("real-font plan measurement follows geometry, font and visibility changes, not fresh record identities", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
	Object.defineProperty(dom.document, "fonts", { value: fonts });
	Object.defineProperty(dom.document, "createRange", { value: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }) });
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	let notifyResize: (() => void) | undefined;
	class ResizeObserverStub {
		constructor(private readonly callback: () => void) {}
		observe() { notifyResize = this.callback; }
		disconnect() { notifyResize = undefined; }
	}
	const globals = {
		React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ fontSize: "12px" }),
		ResizeObserver: ResizeObserverStub,
		requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
		cancelAnimationFrame: (id: number) => { frames.delete(id); },
	};
	const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	Object.assign(globalThis, globals);
	const { createRoot } = await import("react-dom/client");
	const rootEl = dom.document.querySelector("#root")!;
	const root = createRoot(rootEl as unknown as Element);
	let measures = 0;
	let paintWidth = 6;
	let visible = false;
	function Harness({ data }: { data: typeof plan }) {
		const { layout, probe } = usePlanLayout(data);
		return <div data-width={layout.nodeW.get("a")} data-font={layout.fontSize}>
			<svg>
				<text ref={element => {
					probe.sentinel.current = element;
					if (element) {
						element.getComputedTextLength = () => { if (!visible) return 0; measures++; return 100; };
						element.getBBox = () => {
							const width = visible ? 100 : 0;
							const height = visible ? 12 : 0;
							return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({ width, height }) };
						};
					}
				}} />
				<text ref={element => {
					probe.measurer.current = element;
					if (element) element.getComputedTextLength = () => (element.textContent?.length ?? 0) * paintWidth;
				}} />
			</svg>
			<div ref={probe.breaker} />
		</div>;
	}
	const render = (data: typeof plan) => act(async () => { root.render(<Harness data={data} />); });
	const flushFrames = () => act(async () => {
		const pending = [...frames.values()]; frames.clear();
		for (const callback of pending) callback(0);
	});
	try {
		await render(plan);
		await flushFrames();
		assert.equal(measures, 0, "keep the estimated layout while hidden");
		assert.ok(notifyResize);
		visible = true;
		await act(async () => { notifyResize?.(); });
		assert.equal(measures, 1, "measure once when a previously hidden plan becomes visible");
		assert.equal(rootEl.firstElementChild!.getAttribute("data-font"), "12");
		const initial = measures;
		await act(async () => { notifyResize?.(); });
		assert.equal(measures, initial, "unchanged probe bounds do not trigger measurement");
		const restamped = structuredClone(plan);
		restamped.nodes[0]!.status = "visited";
		await render(restamped);
		await flushFrames();
		assert.equal(measures, initial, "neither fresh arrays nor changed status invalidate label layout");
		restamped.nodes[0]!.title = "A considerably wider first label";
		await render(restamped);
		await flushFrames();
		assert.ok(measures > initial);
		const width = Number(rootEl.firstElementChild!.getAttribute("data-width"));
		const beforeFont = measures;
		paintWidth = 8;
		await act(async () => { fonts.dispatchEvent(new Event("loadingdone")); });
		assert.equal(measures, beforeFont + 1);
		assert.ok(Number(rootEl.firstElementChild!.getAttribute("data-width")) > width);
		const beforeEdge = measures;
		await render({ ...restamped, edges: [{ from: "b", to: "a" }] });
		assert.ok(measures > beforeEdge, "a changed edge invalidates geometry even when titles are unchanged");
	} finally {
		await act(async () => { root.unmount(); });
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { usePlanLayout } from "../components/plan-block.tsx";

const plan = {
	nodes: [{ id: "a", title: "Alpha", status: "current" }, { id: "b", title: "Beta", status: "upcoming" }],
	edges: [{ from: "a", to: "b" }],
};

test("real-font plan measurement follows geometry and font changes, not fresh record identities", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
	Object.defineProperty(dom.document, "fonts", { value: fonts });
	Object.defineProperty(dom.document, "createRange", { value: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }) });
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	const globals = {
		React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ fontSize: "12px" }),
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
	function Harness({ data }: { data: typeof plan }) {
		const { layout, probe } = usePlanLayout(data);
		return <div data-width={layout.nodeW.get("a")} data-font={layout.fontSize}>
			<svg>
				<text ref={element => {
					probe.sentinel.current = element;
					if (element) element.getComputedTextLength = () => { measures++; return 100; };
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
		const initial = measures;
		assert.ok(initial > 0);
		assert.equal(rootEl.firstElementChild!.getAttribute("data-font"), "12");
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

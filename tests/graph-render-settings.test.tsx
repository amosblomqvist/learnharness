import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window as any;
const SAVED = {
	sizeUnits: "world", nodeSize: 12, edgeWidth: 3, arrowLength: 1, labelZoom: 1, labelSize: 1,
	clusterLabels: true, clusterLabelSize: 14,
	regions: { bitmap: 384 },
};
const node = (id: string) => ({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [] });
const SNAPSHOT = {
	nodes: [node("a"), node("b")], propositions: [node("a"), node("b")], edges: [], logicalEdges: [], impLinks: [],
	chains: [], sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [], positions: { a: { x: 0, y: 0 }, b: { x: 50, y: 50 } },
};
let releaseGet: () => void;
let getGate: Promise<void>;
let puts: any[] = [];
let getReply: () => Response;
const fetchStub = async (url: string, init?: RequestInit) => {
	if (url === "/api/graph/render-settings") {
		if (init?.method === "PUT") { puts.push(JSON.parse(init.body as string)); return Response.json({}); }
		await getGate;
		return getReply();
	}
	if (url === "/api/graph") return Response.json(SNAPSHOT);
	if (url === "/api/graph/status") return Response.json({ runs: [] });
	if (url === "/api/graph/costs") return Response.json({ stages: [], runs: [] });
	return Response.json({});
};
const nextFrame = (f: (t: number) => void) => setTimeout(() => f(Date.now()), 16);
const ctx: any = new Proxy({}, { get: (_t, p) => (p === "canvas" ? {} : () => ctx), set: () => true });
Object.getPrototypeOf(dom.document.createElement("canvas")).getContext = () => ctx;
for (const [k, v] of Object.entries({
	window: win, document: dom.document, CustomEvent: win.CustomEvent, fetch: fetchStub,
	navigator: { userAgent: "" }, IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem: () => {} },
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	EventSource: class { addEventListener() {} close() {} onmessage = null; onerror = null; },
	requestAnimationFrame: nextFrame, cancelAnimationFrame: clearTimeout, SVGElement: class {}, getComputedStyle: () => ({ getPropertyValue: () => "" }),
	Path2D: class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} addPath() {} },
})) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
(dom.document as any).oninput = null;
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
Object.assign(win, { requestAnimationFrame: nextFrame, cancelAnimationFrame: clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });

const { createRoot } = await import("react-dom/client");
const { GraphView } = await import("../components/graph-view.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

let root: Root | undefined;
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const SAVE_DEBOUNCE_PLUS_SLACK = 700;
async function mount(reply = () => Response.json(SAVED)) {
	puts = [];
	getReply = reply;
	getGate = new Promise<void>((r) => (releaseGet = r));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<ServerEventsProvider><GraphView /></ServerEventsProvider>); });
	await wait(20);
	const gear = [...document.querySelectorAll("button[aria-expanded]")].find((b) => b.innerHTML.includes("lucide-settings")) as HTMLElement;
	await act(async () => { gear.dispatchEvent(new win.Event("click", { bubbles: true })); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; document.body.innerHTML = ""; });
const sliderOf = (label: string) =>
	[...document.querySelectorAll("label")].find((l) => l.textContent!.startsWith(label))!.querySelector("input")! as HTMLInputElement;
const shown = (label: string) => sliderOf(label).parentElement!.querySelector("span span")!.textContent;
const moveSlider = (label: string, value: string) => act(async () => {
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sliderOf(label)), "value")!.set!.call(sliderOf(label), value);
	sliderOf(label).dispatchEvent(new win.Event("input", { bubbles: true }));
});
const loadFailedNotice = () => document.querySelector('[data-testid="graph-settings-load-failed"]');

it("keeps the saved graph settings when a slider moves before they finish loading", async () => {
	await mount();
	await moveSlider("Edge width", "70");
	const movedEdgeWidth = shown("Edge width");
	await act(async () => { releaseGet(); });
	await wait(SAVE_DEBOUNCE_PLUS_SLACK);
	assert.equal(puts.length, 1);
	assert.equal(puts[0].nodeSize, SAVED.nodeSize);
	assert.equal(puts[0].regions.bitmap, SAVED.regions.bitmap);
	assert.notEqual(puts[0].edgeWidth, SAVED.edgeWidth);
	assert.equal(shown("Node size"), "12");
	assert.equal(shown("Edge width"), movedEdgeWidth);
});

it("sends no save when nothing was touched", async () => {
	await mount();
	await act(async () => { releaseGet(); });
	await wait(SAVE_DEBOUNCE_PLUS_SLACK);
	assert.equal(shown("Node size"), "12");
	assert.equal(puts.length, 0);
});

it("saves nothing and says so when the saved graph settings fail to load", async () => {
	await mount(() => Response.json({ error: "read failed" }, { status: 500 }));
	await act(async () => { releaseGet(); });
	const edgeWidthBefore = shown("Edge width");
	await moveSlider("Edge width", "70");
	await wait(SAVE_DEBOUNCE_PLUS_SLACK);
	assert.deepEqual(puts, []);
	assert.notEqual(shown("Edge width"), edgeWidthBefore);
	assert.equal(loadFailedNotice()?.textContent, "Saved settings could not be loaded. Changes won't be saved. Reload to retry.");
});

it("saves the first change when no graph settings are saved yet", async () => {
	await mount(() => Response.json(null));
	await act(async () => { releaseGet(); });
	await moveSlider("Edge width", "70");
	await wait(SAVE_DEBOUNCE_PLUS_SLACK);
	assert.equal(puts.length, 1);
	assert.equal(loadFailedNotice(), null);
});

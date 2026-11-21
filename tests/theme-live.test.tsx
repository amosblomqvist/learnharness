import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { BUILTIN_THEMES, DEFAULT_THEME, type AppearanceSettings, type GraphSnapshot } from "../src/core/index.ts";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { GraphView } from "../components/graph-view.tsx";
import { GraphCanvasRenderer, type CanvasData } from "../components/graph-canvas.ts";

(globalThis as Record<string, unknown>).React = React;

it("same-mode theme/override changes feed new paint to the mounted graph without refetching data or rebuilding its renderer", async t => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const snapshot = {
		nodes: [{ id: "n1", name: "Synthetic node", statement: "A fixture", depth: 0 }],
		edges: [], logicalEdges: [], impLinks: [], clusters: [], nodeSessions: {},
		positions: { n1: { x: 10, y: 20 } },
	} as unknown as GraphSnapshot;
	let graphReads = 0;
	const globals = {
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, SVGElement: dom.window.SVGElement,
		navigator: { maxTouchPoints: 0, userAgent: "fixture" }, IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} disconnect() {} },
		Path2D: class {}, localStorage: { getItem: () => null, setItem() {} },
		requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
		getComputedStyle: (element: Element) => ({
			fontFamily: "fixture-mono",
			getPropertyValue: (name: string) => (element as HTMLElement).style.getPropertyValue(name),
		}),
		fetch: async (input: unknown) => {
			switch (String(input)) {
				case "/api/themes": return Response.json({ themes: BUILTIN_THEMES });
				case "/api/graph": graphReads++; return Response.json(snapshot);
				case "/api/graph/render-settings": return Response.json({});
				case "/api/graph/status": return Response.json({ runs: [] });
				case "/api/graph/costs": return Response.json(null);
				default: throw new Error(`Unexpected fixture fetch: ${input}`);
			}
		},
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	const canvasProto = Object.getPrototypeOf(dom.document.createElement("canvas"));
	const previousContext = Object.getOwnPropertyDescriptor(canvasProto, "getContext");
	Object.defineProperty(canvasProto, "getContext", { configurable: true, value() {
		return {
			fillStyle: "#000000", setTransform() {}, fillRect() {},
			getImageData(this: { fillStyle: string }) {
				const hex = this.fillStyle.slice(1);
				return { data: [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(255) };
			},
		};
	} });
	const feeds: CanvasData[] = [], renderers: GraphCanvasRenderer[] = [];
	t.mock.method(GraphCanvasRenderer.prototype, "setData", function (this: GraphCanvasRenderer, data: CanvasData) { feeds.push(data); renderers.push(this); });
	for (const method of ["setSettings", "setVisible", "setRegionTuning", "setPhysicsTuning"] as const) t.mock.method(GraphCanvasRenderer.prototype, method, () => {});
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let live!: ReturnType<typeof useAppearance>;
	function Probe() { live = useAppearance(); return <GraphView />; }
	const mocha = BUILTIN_THEMES.find(theme => theme.id === "catppuccin-mocha")!;
	const gruvbox = BUILTIN_THEMES.find(theme => theme.id === "gruvbox-dark")!;
	try {
		await act(async () => root.render(
			<InteractionLayersProvider><ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
				<AppearanceProvider initialAppearance={{ theme: mocha.id }} initialTheme={mocha}><Probe /></AppearanceProvider>
			</ServerEventsProvider></InteractionLayersProvider>,
		));
		assert.ok(feeds.length > 0, "real GraphView reaches its canvas feed");
		assert.equal(feeds.at(-1)!.colors.label, mocha.colors.textMuted);
		const count = feeds.length;
		await act(async () => live.onAppearanceChange({ theme: gruvbox.id }));
		assert.equal(live.resolvedMode, "dark");
		assert.ok(feeds.length > count, "dark→dark palette switching refreshes captured canvas paint");
		assert.equal(feeds.at(-1)!.colors.node, gruvbox.colors.text);
		assert.equal(feeds.at(-1)!.colors.edge, gruvbox.colors.textMuted);
		await act(async () => live.onAppearanceChange({ theme: gruvbox.id, colors: { text: "#123456", textMuted: "#654321" } }));
		assert.equal(feeds.at(-1)!.colors.hoverText, "#123456");
		assert.equal(feeds.at(-1)!.colors.label, "#654321");
		assert.equal(new Set(renderers).size, 1, "palette changes preserve the renderer/camera instance");
		assert.equal(graphReads, 1, "no snapshot event is needed to refresh the palette");
	} finally {
		await act(async () => root.unmount());
		t.mock.restoreAll();
		if (previousContext) Object.defineProperty(canvasProto, "getContext", previousContext); else Reflect.deleteProperty(canvasProto, "getContext");
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});

it("a server palette refresh cannot overwrite newer live colors or mode; typography resets still clear inline overrides", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async () => Response.json({ themes: BUILTIN_THEMES }) };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let live!: ReturnType<typeof useAppearance>;
	function Probe() { live = useAppearance(); return null; }
	const dawn = BUILTIN_THEMES.find(theme => theme.id === "rose-pine-dawn")!;
	const render = (initialAppearance: AppearanceSettings, initialTheme = DEFAULT_THEME) => root.render(
		<AppearanceProvider initialAppearance={initialAppearance} initialTheme={initialTheme}><Probe /></AppearanceProvider>,
	);
	try {
		await act(async () => render({}));
		await act(async () => live.onAppearanceChange({ theme: dawn.id, colors: { text: "#123456" }, fontFamily: "Georgia", sessionNameSerif: false }));
		assert.equal(document.documentElement.style.getPropertyValue("--foreground"), "#123456");
		// Simulate <html> rewritten by a refreshed layout before provider effects.
		document.documentElement.className = "dark";
		document.documentElement.style.setProperty("--foreground", "#111111");
		await act(async () => render({ colors: { text: "#111111" } }, { ...DEFAULT_THEME, mode: "light" }));
		assert.equal(document.documentElement.classList.contains("light"), true);
		assert.equal(document.documentElement.style.getPropertyValue("--foreground"), "#123456");
		assert.match(document.documentElement.style.getPropertyValue("--font-prose"), /Georgia/);
		await act(async () => live.onAppearanceChange({ theme: dawn.id }));
		assert.equal(document.documentElement.style.getPropertyValue("--foreground"), dawn.colors.text);
		assert.equal(document.documentElement.style.getPropertyValue("--font-prose"), "");
		assert.equal(document.documentElement.style.getPropertyValue("--font-title"), "");
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});

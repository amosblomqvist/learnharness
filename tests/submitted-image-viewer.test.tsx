import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SubmittedImages } from "../components/submitted-images.tsx";
import { MermaidOverlay, SessionMermaidContext, type SessionImage } from "../components/session-overlay.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

Object.assign(globalThis, { React });
const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
const source = `data:${image.mimeType};base64,${image.data}`;

test("raster images reuse the figure viewport without SVG markup, white backing or inversion", () => {
	const html = renderToStaticMarkup(<InteractionLayersProvider><MermaidOverlay image={{ src: source, width: 2000, height: 1375 }} onClose={() => {}} /></InteractionLayersProvider>);
	const { document } = parseHTML(html);
	const overlay = document.querySelector('[data-testid="mermaid-overlay"]')!;
	assert.equal(overlay.getAttribute("aria-label"), "Image focus");
	assert.equal(overlay.querySelector("img")?.getAttribute("src"), source);
	assert.equal(overlay.querySelector("img")?.getAttribute("draggable"), "false");
	assert.equal(overlay.querySelector("svg image"), null);
	assert.equal(overlay.querySelector("[data-lh-overlay-chart]"), null);
	assert.ok(overlay.querySelector('[aria-label="Zoom in"]'));
	assert.ok(overlay.querySelector('[aria-label="Fit image to view"]'));
	assert.doesNotMatch(html, /filter:invert|bg-white/);
});

test("clicking a thumbnail opens the same accepted bytes in the shared viewer and X closes it", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const root = createRoot(document.getElementById("root")!);
	function Harness() {
		const [focus, setFocus] = useState<SessionImage | null>(null);
		return <SessionMermaidContext.Provider value={{ openMermaid() {}, openFigure() {}, openImage: setFocus }}>
			<SubmittedImages images={[image]} />
			{focus && <MermaidOverlay image={focus} onClose={() => setFocus(null)} />}
		</SessionMermaidContext.Provider>;
	}
	try {
		await act(async () => root.render(<InteractionLayersProvider><Harness /></InteractionLayersProvider>));
		const thumbnail = document.querySelector('[data-testid="submitted-images"] img')!;
		Object.defineProperties(thumbnail, { naturalWidth: { value: 2000 }, naturalHeight: { value: 1375 } });
		await act(async () => { document.querySelector('[aria-label="Open submitted image fullscreen"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		const expanded = document.querySelector('[data-testid="mermaid-overlay"] img')!;
		assert.equal(expanded.getAttribute("src"), thumbnail.getAttribute("src"));
		await act(async () => { document.querySelector('[data-testid="mermaid-overlay-close"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		assert.equal(document.querySelector('[data-testid="mermaid-overlay"]'), null);
		assert.equal(document.querySelector('[data-testid="submitted-images"] img'), thumbnail);
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

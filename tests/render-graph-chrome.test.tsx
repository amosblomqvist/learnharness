/**
 * Empty-graph chrome pins (empty-graph chrome wave, owner 2026-09-25):
 * Import Notes renders ALWAYS — the one action that works on an empty
 * graph, the entry point itself; search + settings render only when the
 * snapshot has nodes (dead controls are lies — the honesty principle).
 * GraphChromeRow is the pure seam (the DeleteNodeBody pattern): SSR of
 * both states pins the ruling. Fetches don't run under renderToStaticMarkup
 * (effects never fire), so these pins exercise the component directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { parseHTML } from "linkedom";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { GraphChromeRow, GraphView, NodeCardText, observeNodeCardPosition } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";
import { ServerEventsProvider } from "../components/server-events.tsx";

/** Ref doubles — the SSR harness never attaches them. */
const ref = { current: null };

const PROPS = {
	query: "",
	onQuery: () => {},
	noMatch: false,
	importing: false,
	searchInputRef: ref,
	onImportFiles: () => {},
	settings: {} as GraphRenderSettings,
	changeSettings: () => {},
	onOpenChains: () => {},
};

describe("GraphChromeRow — the empty-graph ruling (owner, 2026-09-25)", () => {
	it("EMPTY graph: Import and source inventory render; canvas search/settings stay absent", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Extract files…"));
		assert.ok(html.includes("lucide-waypoints"));
		assert.ok(!html.includes("lucide-upload"));
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(!html.includes("lucide-settings"), "settings is a lie on an empty graph");
		assert.ok(html.includes('data-testid="open-chain-table"'), "source inventory includes chats/files without graph nodes");
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 1, "only the inventory button has the appearance animation");
	});

	it("empty graph uses the same session-first lead and secondary material guidance as home", () => {
		const html = renderToStaticMarkup(createElement(ServerEventsProvider, { children: createElement(GraphView, {}) }));
		assert.ok(html.includes("<p>Start a session to begin learning.</p>"));
		assert.ok(html.includes("Attach your material with the paperclip or drag and drop.</p>"));
		assert.ok(!html.includes("import notes to build"));
	});

	it("POPULATED graph: all four render, the gated trio carries the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
		assert.ok(html.includes('data-testid="open-chain-table"'), "the chains entry renders");
		// the appear-once fade rides exactly the three gated controls, never Import Notes
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 3, "three fade carriers: search + chains + settings");
	});

	it("the no-match note renders only when the wrapper says so (its truth stays upstream)", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: true }),
		);
		assert.ok(html.includes("No matching nodes."));
		const quiet = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: false }),
		);
		assert.ok(!quiet.includes("No matching nodes."));
	});
});

/** The node detail card renders its name and statement like other tool
 *  content, so math no longer shows as raw dollars. NodeCardText is the
 *  seam: the card itself only mounts from GraphView's click state. */
describe("node detail card text", () => {
	const render = (name: string, statement: string) => renderToStaticMarkup(createElement(NodeCardText, { name, statement }));
	const formulas = (html: string) => html.split('class="katex"').length - 1;

	it("renders math in the name and in the statement", () => {
		const html = render(String.raw`Euler's formula $e^{ix}$`, String.raw`For real $x$, $e^{ix}=\cos x+i\sin x$.`);
		assert.equal(formulas(html), 3);
		assert.ok(!html.includes("$"), "no raw dollar delimiters remain");
		assert.ok(html.includes("For real"), "the surrounding prose survives");
	});

	it("renders a display block in the statement as display math", () => {
		const html = render("Gaussian integral", "Over the real line:\n\n$$\n" + String.raw`\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}` + "\n$$");
		assert.equal(formulas(html), 1);
		assert.ok(html.includes("katex-display"));
	});

	it("leaves plain text as plain text", () => {
		const statement = "The maximum ratio of broad money a bank can create from each unit of base money.";
		const html = render("Money multiplier", statement);
		assert.equal(formulas(html), 0);
		assert.ok(html.includes("Money multiplier") && html.includes(statement));
	});

	it("uses the shared Markdown and image-safety policy without changing the source fields", () => {
		const source = {
			name: "**Meaning** $x$",
			statement: "A [reference](https://example.invalid/) and `literal` code.\n\n| Value | Meaning |\n| --- | --- |\n| $x$ | Variable |\n\n![untrusted](https://example.invalid/image.png)",
		};
		const before = structuredClone(source);
		const html = render(source.name, source.statement);
		const { document } = parseHTML(html);
		assert.equal(document.querySelector("strong")?.textContent, "Meaning");
		assert.equal(document.querySelector('[data-streamdown="inline-code"]')?.textContent, "literal");
		assert.ok(document.querySelector("table"), "ordinary Markdown tables use the shared renderer");
		assert.equal(document.querySelector("img"), null, "node content cannot load a remote image");
		assert.ok(html.includes("[Image blocked: untrusted]"));
		assert.deepEqual(source, before);
	});

	it("lets inline code inherit each card line's size and colour without changing its monospace surface", () => {
		const { document } = parseHTML(render("Name `x`", "Statement `x`"));
		const lines = [...document.querySelectorAll(".lh-prose")];
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.ok(line.classList.contains("[&_[data-streamdown=inline-code]]:[font-size:inherit]"));
			assert.ok(line.classList.contains("[&_[data-streamdown=inline-code]]:[color:inherit]"));
			const code = line.querySelector('[data-streamdown="inline-code"]')!;
			for (const token of ["font-mono", "px-1.5", "py-0.5"]) assert.ok(code.classList.contains(token));
		}
	});

	it("keeps the card's own type rather than the chat prose font and size", () => {
		const html = render("Name", "Statement");
		assert.equal(html.split("[--font-prose:var(--font-ui)]").length - 1, 2, "both lines stay in the UI font");
		assert.match(html, /class="[^"]*font-medium[^"]*\[--lh-prose-size:var\(--text-sm\)\][^"]*"/, "the name keeps its size and weight");
		assert.match(html, /class="[^"]*text-muted-foreground[^"]*\[--lh-prose-size:var\(--text-xs\)\][^"]*"/, "the statement keeps its size and colour");
	});
});

describe("node detail card placement", () => {
	it("remeasures late content and container changes, then disconnects on cleanup", () => {
		const previous = globalThis.ResizeObserver;
		const observed: Element[] = [];
		let notify: () => void = () => { throw new Error("observer not created"); };
		let disconnected = false;
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) { notify = callback; }
			observe(element: Element) { observed.push(element); }
			disconnect() { disconnected = true; }
		} as unknown as typeof ResizeObserver;
		try {
			const card = { offsetWidth: 320, offsetHeight: 164, style: { left: "", top: "", visibility: "hidden" } };
			const container = { clientWidth: 600, clientHeight: 560 };
			const cleanup = observeNodeCardPosition(card as HTMLDivElement, container as HTMLDivElement, { x: 300, y: 500 });
			assert.deepEqual(observed, [card, container]);
			assert.deepEqual(card.style, { left: "140px", top: "324px", visibility: "visible" });
			// A diagram/plugin can finish after the initial layout effect. Keep
			// the same 12px node gap instead of leaving its bottom off-screen.
			card.offsetHeight = 308;
			notify();
			assert.equal(card.style.top, "180px");
			assert.equal(Number.parseInt(card.style.top) + card.offsetHeight, 488);
			container.clientWidth = 360;
			notify();
			assert.equal(card.style.left, "32px", "container resize retains the existing horizontal clamp");
			container.clientHeight = 900;
			notify();
			assert.equal(card.style.top, "512px", "a taller container has room below the node again");
			cleanup();
			assert.equal(disconnected, true, "selection changes/unmount release both observations");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
			else globalThis.ResizeObserver = previous;
		}
	});

	it("retains initial below-node placement and edge clamps without an observer", () => {
		const previous = globalThis.ResizeObserver;
		Reflect.deleteProperty(globalThis, "ResizeObserver");
		try {
			const card = { offsetWidth: 320, offsetHeight: 100, style: { left: "", top: "", visibility: "hidden" } };
			const container = { clientWidth: 600, clientHeight: 560 };
			const cleanup = observeNodeCardPosition(card as HTMLDivElement, container as HTMLDivElement, { x: 10, y: 30 });
			assert.deepEqual(card.style, { left: "8px", top: "42px", visibility: "visible" });
			cleanup();
			card.offsetHeight = 700;
			observeNodeCardPosition(card as HTMLDivElement, container as HTMLDivElement, { x: 590, y: 500 })();
			assert.equal(card.style.left, "272px");
			assert.equal(card.style.top, "8px", "oversized content keeps the existing top-margin clamp");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
			else globalThis.ResizeObserver = previous;
		}
	});
});

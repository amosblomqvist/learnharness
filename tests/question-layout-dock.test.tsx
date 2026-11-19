import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock, type QuestionLayoutRequest } from "../components/question-dock.tsx";
import { questionContentReady, type QuestionLayout } from "../components/question-layout.ts";
import type { QuizToolInput } from "../src/core/question-core.ts";

// Synthetic geometry seam (linkedom has no layout): every box is 100px tall
// and as wide as its inline width. Proves the card's arrangement and WHEN it
// measures — not real line wrapping, which the browser check covers.
const dom = parseHTML("<html><body></body></html>");
let measurements = 0;
const style = (el: Element) => ({
	paddingLeft: "16px", paddingRight: "16px", borderLeftWidth: "0px", borderRightWidth: "0px", overflowX: "visible",
	width: (el as HTMLElement).style?.width ?? "",
});
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: (el: Element) => { measurements++; return style(el); },
	ResizeObserver: class { observe() {} disconnect() {} },
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
	configurable: true,
	value(this: HTMLElement) { return { width: Number.parseFloat(this.style.width) || 0, height: 100 }; },
});

const input: QuizToolInput = {
	question: "A long question", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
	correctAnswer: "yes", explanation: "Yes is correct.",
} as QuizToolInput;
const request: QuestionLayoutRequest = { available: 1200, base: 702, floor: 368, key: "font" };

async function mount(layoutRequest: QuestionLayoutRequest | null, layouts: (QuestionLayout | null)[], toolCallId = "q1") {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const render = (req: QuestionLayoutRequest | null) => act(async () => root.render(
		<QuestionDock toolName="quiz" toolCallId={toolCallId} input={input} expanded onExpand={() => {}} onSubmit={() => {}}
			dictationClaim={false} layoutRequest={req} onLayout={(l) => layouts.push(l)} />,
	));
	await render(layoutRequest);
	return { host, root, render };
}

test("adaptation off: today's stacked card, nothing measured, no layout reported", async () => {
	const layouts: (QuestionLayout | null)[] = [];
	measurements = 0;
	const { host, root } = await mount(null, layouts);
	try {
		const dock = host.querySelector('[data-testid="question-dock"]')!;
		assert.equal(dock.getAttribute("data-question-layout"), "stacked");
		assert.equal(host.querySelector('[data-testid="question-columns"]'), null);
		const scroll = dock.querySelector("[data-dock-scroll-area]")!;
		assert.ok(scroll.querySelector("[data-question-part]") && scroll.querySelector("[data-question-options]"));
		// Confidence has no box of its own: it follows the options inside the
		// scrolling area (sharing its padding), above "Your thinking".
		const confidence = scroll.querySelector<HTMLElement>("[data-question-confidence]")!;
		assert.ok(confidence, "confidence scrolls with the options");
		assert.equal(confidence.previousElementSibling?.hasAttribute("data-question-options"), true);
		assert.equal(/border-t|px-4/.test(confidence.className), false, "no separator, no second side padding");
		assert.equal(measurements, 0);
		assert.ok(layouts.every((l) => l === null));
		assert.equal(document.querySelector("[data-question-layout-probe]"), null);
	} finally { await act(async () => root.unmount()); host.remove(); }
});

test("adaptation on: question left, options + pinned confidence right, thinking full width below; typing never re-measures", async () => {
	const layouts: (QuestionLayout | null)[] = [];
	measurements = 0;
	const { host, root, render } = await mount(request, layouts);
	try {
		const dock = host.querySelector('[data-testid="question-dock"]')!;
		assert.equal(dock.getAttribute("data-question-layout"), "columns");
		const solved = layouts.at(-1);
		assert.equal(solved?.kind, "columns");
		const grid = host.querySelector<HTMLElement>('[data-testid="question-columns"]')!;
		assert.ok(grid.hasAttribute("data-dock-height-region"), "the row is the dock's height-variable region");
		const [left, right] = [...grid.children] as HTMLElement[];
		assert.ok(left!.querySelector("[data-question-part]"));
		assert.equal(left!.querySelector("[data-question-options]"), null);
		assert.ok(right!.querySelector("[data-question-options]"));
		assert.equal(right!.lastElementChild?.hasAttribute("data-question-confidence"), true, "confidence pinned to the answer column's bottom");
		// No divider; options and confidence centered together vertically.
		assert.equal(right!.className.includes("border-l"), false);
		assert.equal(right!.lastElementChild!.className.includes("border-t"), false);
		assert.ok(right!.className.split(" ").includes("justify-center"));
		// "Your thinking" stays outside the columns.
		assert.equal(grid.querySelector('[data-testid="thinking-field"]'), null);
		assert.ok(dock.querySelector('[data-testid="thinking-field"]'));
		assert.equal(document.querySelector("[data-question-layout-probe]"), null, "the probe is removed after measuring");

		const before = measurements;
		const reported = layouts.length;
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
			const editor = host.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
			editor.textContent = "typing";
			editor.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		assert.equal(measurements, before, "selection and typing never measure");
		assert.equal(layouts.length, reported);

		// A width change DECIDES from the saved measurements: no content
		// measuring (window resizes stay arithmetic), whatever the budget.
		await render({ ...request });
		assert.equal(measurements, before);
		await render({ ...request, available: 1190 });
		assert.equal(measurements, before, "a slightly smaller budget");
		await render({ ...request, available: 700 });
		assert.equal(measurements, before, "a budget too small for two columns");
		assert.equal(layouts.at(-1)?.kind, "stacked", "floors 368 + 368 cannot fit in 700");
		assert.equal(dock.getAttribute("data-question-layout"), "stacked");
		await render({ ...request, available: 1100 });
		assert.equal(measurements, before, "and back");
		assert.equal(layouts.at(-1)?.kind, "columns");
		// Any probe lives in the persistent contained host, never loose in the card.
		const probeHost = dock.querySelector<HTMLElement>("[data-question-layout-host]")!;
		assert.ok(probeHost, "a persistent measuring host");
		assert.equal(probeHost.style.contain, "strict");
		assert.equal(probeHost.childElementCount, 0, "probes are removed after measuring");
		assert.equal(dock.getAttribute("data-question-layout"), "columns");

		// Turning adaptation off reports no layout.
		await render(null);
		assert.equal(layouts.at(-1), null);
	} finally { await act(async () => root.unmount()); host.remove(); }
	assert.equal(layouts.at(-1), null, "unmount clears the layout");
});

test("a remounted question reuses its solved layout without measuring", async () => {
	const first: (QuestionLayout | null)[] = [];
	const a = await mount(request, first, "q-reuse");
	await act(async () => a.root.unmount()); a.host.remove();
	measurements = 0;
	const again: (QuestionLayout | null)[] = [];
	const b = await mount(request, again, "q-reuse");
	try {
		assert.equal(measurements, 0);
		assert.deepEqual(again.at(-1), first.findLast((l) => l !== null));
		assert.equal(b.host.querySelector('[data-testid="question-dock"]')!.getAttribute("data-question-layout"), "columns");
	} finally { await act(async () => b.root.unmount()); b.host.remove(); }
});

test("content readiness: a rendering diagram, its pending size cap, a loading image or font", () => {
	const part = document.createElement("div");
	const options = document.createElement("div");
	assert.equal(questionContentReady({ question: part, options }), true);
	part.innerHTML = '<div data-testid="md-mermaid" aria-busy="true"></div>';
	assert.equal(questionContentReady({ question: part, options }), false, "diagram still rendering");
	part.innerHTML = '<div data-testid="md-mermaid" data-streamdown="mermaid"><div><svg></svg></div><div><button><svg></svg></button></div></div>';
	assert.equal(questionContentReady({ question: part, options }), false, "font-parity cap not applied yet");
	(part.querySelector("svg")!.parentElement as HTMLElement).style.maxWidth = "1058px";
	assert.equal(questionContentReady({ question: part, options }), true);
	options.innerHTML = "<img>";
	Object.defineProperty(options.querySelector("img")!, "complete", { value: false });
	assert.equal(questionContentReady({ question: part, options }), false, "image still loading");
	options.innerHTML = "";
	Object.defineProperty(document, "fonts", { configurable: true, value: { status: "loading" } });
	try {
		assert.equal(questionContentReady({ question: part, options }), false, "web fonts still loading");
	} finally { delete (document as { fonts?: unknown }).fonts; }
});

test("a content change after solving (a font finished loading) re-measures; the fresh result is what a remount reuses", async () => {
	const faces: { status: string }[] = [];
	const fonts = Object.assign(new dom.window.EventTarget(), { status: "loaded", [Symbol.iterator]: () => faces[Symbol.iterator]() });
	Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
	try {
		const layouts: (QuestionLayout | null)[] = [];
		const a = await mount(request, layouts, "q-font");
		const afterFirst = measurements;
		assert.ok(afterFirst > 0);
		// The KaTeX font arrives: same element tree, different fingerprint.
		faces.push({ status: "loaded" });
		await act(async () => {
			fonts.dispatchEvent(new dom.window.Event("loadingdone"));
			await new Promise((r) => setTimeout(r, 5));
		});
		assert.ok(measurements > afterFirst, "the bump bypasses the cached layout");
		// Chrome repeats "loadingdone" during window resizes for fonts that
		// loaded long ago: nothing new loaded, nothing re-measured.
		const settled = measurements;
		await act(async () => {
			fonts.dispatchEvent(new dom.window.Event("loadingdone"));
			await new Promise((r) => setTimeout(r, 5));
		});
		assert.equal(measurements, settled, "a repeated font event is not new content");
		await act(async () => a.root.unmount()); a.host.remove();

		const before = measurements;
		const b = await mount(request, [], "q-font");
		assert.equal(measurements, before, "same content and fonts: the fresh result is reused");
		await act(async () => b.root.unmount()); b.host.remove();

		faces.push({ status: "loaded" });
		fonts.dispatchEvent(new dom.window.Event("loadingdone"));
		const c = await mount(request, [], "q-font");
		assert.ok(measurements > before, "different loaded fonts: never reuse a layout solved before them");
		await act(async () => c.root.unmount()); c.host.remove();
	} finally { delete (document as { fonts?: unknown }).fonts; }
});

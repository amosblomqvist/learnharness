import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

// Synthetic geometry seam (linkedom has no layout): each box gets a fixed
// rect; a scroller's content moves up by its scrollTop. Proves WHICH
// scrollers move and by how much — the browser check covers real layout.
const dom = parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window as unknown as Window & typeof globalThis;
let frames: (() => void)[] = [];
Object.assign(win, {
	requestAnimationFrame: (cb: () => void) => { frames.push(cb); return frames.length; },
	cancelAnimationFrame: () => {},
	innerHeight: 600,
	innerWidth: 800,
	getComputedStyle: (el: Element) => ({ overflowY: el.hasAttribute("data-dock-scroll-area") || el.hasAttribute("data-dock-viewport") ? "auto" : "visible" }),
});
Object.assign(globalThis, { window: win, document: dom.document, HTMLElement: win.HTMLElement });
const { captureReadingPosition, holdAcrossSwitch, restoreReadingPosition, revealFocused, scrollNearest, trackReadingPosition, visibleFocused } = await import("../components/dock-switch.ts");

type Box = { top: number; height: number; scrollHeight?: number };
const boxes = new WeakMap<Element, Box>();
const offset = (el: Element) => {
	let y = 0;
	for (let p = el.parentElement; p; p = p.parentElement) y -= (p as HTMLElement).scrollTop || 0;
	return y;
};
Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", {
	configurable: true,
	value(this: HTMLElement) {
		const b = boxes.get(this) ?? { top: 0, height: 0 };
		const top = b.top + offset(this);
		return { top, bottom: top + b.height, height: b.height, width: 100, left: 0, right: 100 };
	},
});
for (const [prop, get] of [
	["clientHeight", (b: Box) => b.height],
	["scrollHeight", (b: Box) => b.scrollHeight ?? b.height],
	["clientTop", () => 0],
] as const) {
	Object.defineProperty(win.HTMLElement.prototype, prop, {
		configurable: true,
		get(this: HTMLElement) { const b = boxes.get(this); return b ? get(b) : 0; },
	});
}

function el(tag: string, box: Box, attrs: Record<string, string> = {}) {
	const e = dom.document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
	boxes.set(e, box);
	(e as HTMLElement).scrollTop = 0;
	return e as HTMLElement;
}

/** A dock: viewport (whole-card scroll) > scroll area (0–300 on screen,
 *  1000 of content) > an editor placed at `editorTop` in the content. */
function dock(editorTop: number) {
	const viewport = el("div", { top: 0, height: 400, scrollHeight: 400 }, { "data-dock-viewport": "" });
	const root = el("div", { top: 0, height: 400 });
	const area = el("div", { top: 0, height: 300, scrollHeight: 1000 }, { "data-dock-scroll-area": "" });
	const editor = el("div", { top: editorTop, height: 20 }, { role: "textbox", tabindex: "0" });
	area.append(editor); root.append(area); viewport.append(root); dom.document.body.append(viewport);
	return { viewport, root, area, editor };
}

test("scrollNearest: the least scroll that shows the element, with a margin; nothing when it is visible", () => {
	const { area, editor } = dock(772);
	scrollNearest(area, editor);
	// bottom 792 must reach 300 - 8 = 292 → scrolled by exactly 500.
	assert.equal(area.scrollTop, 500);
	scrollNearest(area, editor);
	assert.equal(area.scrollTop, 500, "already visible: unchanged");
	area.scrollTop = 900; // now above the view
	scrollNearest(area, editor);
	assert.equal(area.scrollTop, 772 - 8, "brought down to the top margin");
	dom.document.body.replaceChildren();
});

test("revealFocused: only the focused control inside the card; never scrolls past the dock's viewport", () => {
	const { viewport, root, area, editor } = dock(772);
	const outside = el("div", { top: 0, height: 100, scrollHeight: 5000 }, { "data-dock-scroll-area": "" });
	outside.append(viewport); dom.document.body.append(outside);
	revealFocused(root);
	assert.equal(area.scrollTop, 0, "nothing focused inside: nothing moves");
	editor.focus();
	if (dom.document.activeElement !== editor) Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => editor });
	revealFocused(root);
	assert.equal(area.scrollTop, 500);
	assert.equal(outside.scrollTop, 0, "an ancestor above the dock's viewport is never scrolled");
	Reflect.deleteProperty(dom.document, "activeElement");
	dom.document.body.replaceChildren();
});

test("only visible focus gets priority: scroll clips can hide a focused editor without blurring it", () => {
	const { viewport, root, area, editor } = dock(772);
	Object.defineProperty(dom.document, "activeElement", { configurable: true, value: editor });
	try {
		assert.equal(visibleFocused(root), null, "clipped by the answer area");
		area.scrollTop = 490;
		assert.equal(visibleFocused(root), editor, "part of the editor is visible");
		area.scrollTop = 500;
		assert.equal(visibleFocused(root), editor, "the whole editor is visible");
		boxes.get(viewport)!.height = 250;
		assert.equal(visibleFocused(root), null, "an outer clip also counts");
		assert.equal(dom.document.activeElement, editor, "the focus snapshot never blurs the editor");
	} finally {
		Reflect.deleteProperty(dom.document, "activeElement");
		dom.document.body.replaceChildren();
	}
});

test("moving from options in stacked layout keeps the end of the question beside the visible option", () => {
	const { root, area } = dock(900);
	const question = el("div", { top: 0, height: 450 });
	const options = el("div", { top: 450, height: 450 });
	const row = el("button", { top: 525, height: 25 }, { "data-kbdrow": "2" });
	options.append(row);
	area.replaceChildren(question, options);
	area.scrollTop = 520;
	const anchors = captureReadingPosition(question, options, true);
	assert.deepEqual(anchors.map((a) => a.target), [question, row]);

	const right = el("div", { top: 0, height: 300, scrollHeight: 450 }, { "data-dock-scroll-area": "" });
	root.append(right);
	right.append(options);
	boxes.get(row)!.top = 75;
	restoreReadingPosition(anchors);
	assert.equal(area.scrollTop, 450 - (300 - 8), "left shows the end");
	assert.equal(right.scrollTop, 75, "right shows the anchored choice");
	dom.document.body.replaceChildren();
});

test("read-position tracking ignores scroll events caused by resizing the old scroller", () => {
	const { area, editor } = dock(0);
	const callbacks: (() => void)[] = [];
	Object.assign(globalThis, { ResizeObserver: class {
		constructor(callback: () => void) { callbacks.push(callback); }
		observe() {}
		disconnect() {}
	} });
	let width = 600;
	Object.defineProperty(editor, "clientWidth", { get: () => width });
	let saved = 0;
	const stop = trackReadingPosition(editor, () => null, () => saved++);
	const scroll = () => area.dispatchEvent(new win.Event("scroll", { bubbles: true }));
	scroll();
	assert.equal(saved, 1);
	width = 500;
	scroll();
	assert.equal(saved, 1, "scroll caused by reflow cannot replace the saved position");
	callbacks[0]!();
	scroll();
	assert.equal(saved, 2, "scrolling works at the new width");
	stop();
	scroll();
	assert.equal(saved, 2, "cleanup removes the listener");
	dom.document.body.replaceChildren();
});

test("holdAcrossSwitch: applies at once and every frame until the scrollers settle; the learner's own input ends it", () => {
	frames = [];
	const { root, area } = dock(0);
	let applied = 0;
	holdAcrossSwitch(root, () => applied++, { stableFrames: 2 });
	assert.equal(applied, 1, "once immediately");
	// The caps are still landing: the scroller's height changes per frame.
	boxes.get(area)!.height = 280; frames.shift()!();
	boxes.get(area)!.height = 260; frames.shift()!();
	assert.equal(applied, 3);
	frames.shift()!(); frames.shift()!(); // two stable frames
	assert.equal(applied, 5);
	assert.equal(frames.length, 0, "settled: stops");

	frames = [];
	applied = 0;
	holdAcrossSwitch(root, () => applied++);
	dom.document.dispatchEvent(new win.Event("keydown"));
	while (frames.length) frames.shift()!();
	assert.equal(applied, 1, "a keystroke ends the hold: never fights typing or scrolling");
	dom.document.body.replaceChildren();
});

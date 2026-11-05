import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { radioTarget, SegmentedControl } from "../components/settings/controls.tsx";

/**
 * The segmented control follows the ARIA radio group: one tab stop (the
 * chosen button, roving), and the arrow keys plus Home/End move focus and
 * choose. Mounted against an isolated DOM like the other interaction tests.
 */

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
let focused: Element | undefined;
dom.window.HTMLElement.prototype.focus = function () { focused = this; };
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused ?? document.body });

const OPTIONS = [
	{ value: "left", label: "Left" },
	{ value: "center", label: "Center" },
	{ value: "right", label: "Right" },
	{ value: "justify", label: "Justify" },
] as const;
type Value = (typeof OPTIONS)[number]["value"];

describe("radioTarget (the arrow machine)", () => {
	it("arrows step with wrap, Home/End jump, other keys are not owned", () => {
		assert.equal(radioTarget("ArrowRight", 0, 4), 1);
		assert.equal(radioTarget("ArrowDown", 2, 4), 3);
		assert.equal(radioTarget("ArrowRight", 3, 4), 0, "wraps forward");
		assert.equal(radioTarget("ArrowLeft", 2, 4), 1);
		assert.equal(radioTarget("ArrowUp", 0, 4), 3, "wraps back");
		assert.equal(radioTarget("Home", 2, 4), 0);
		assert.equal(radioTarget("End", 1, 4), 3);
		for (const key of ["Enter", " ", "a", "Tab", "PageDown", "Escape"]) assert.equal(radioTarget(key, 1, 4), null, key);
		assert.equal(radioTarget("ArrowRight", 0, 0), null, "an empty group owns nothing");
		assert.equal(radioTarget("ArrowRight", 0, 1), 0, "a lone radio stays put");
	});
});

describe("SegmentedControl roving tabindex", () => {
	const stops = (value: string) => {
		const html = renderToStaticMarkup(<SegmentedControl value={value} options={OPTIONS} onChange={() => {}} ariaLabel="Text alignment" testid="seg" />);
		return OPTIONS.map((o) => html.match(new RegExp(`<button[^>]*data-testid="seg-${o.value}"[^>]*>`))?.[0].match(/tabindex="(-?\d)"/)?.[1]);
	};

	it("only the chosen radio is a tab stop", () => {
		assert.deepEqual(stops("left"), ["0", "-1", "-1", "-1"]);
		assert.deepEqual(stops("right"), ["-1", "-1", "0", "-1"]);
		assert.deepEqual(stops("justify"), ["-1", "-1", "-1", "0"]);
	});

	it("with no chosen radio the first one is the tab stop", () => {
		assert.deepEqual(stops("nothing-chosen"), ["0", "-1", "-1", "-1"]);
	});
});

describe("SegmentedControl keyboard", () => {
	let root: Root | undefined;
	let host: HTMLDivElement | undefined;
	let changes: Value[];
	let documentKeys: string[];
	const onDocumentKey = (event: Event) => { documentKeys.push((event as unknown as { key: string }).key); };

	async function mount(initial: Value) {
		changes = [];
		documentKeys = [];
		focused = undefined;
		document.addEventListener("keydown", onDocumentKey);
		function Harness() {
			const [value, setValue] = useState<Value>(initial);
			return <SegmentedControl value={value} options={OPTIONS} ariaLabel="Text alignment" testid="seg" onChange={(next) => { changes.push(next); setValue(next); }} />;
		}
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => { root!.render(<Harness />); });
	}
	afterEach(async () => {
		document.removeEventListener("keydown", onDocumentKey);
		await act(async () => { root?.unmount(); });
		root = undefined;
		host?.remove();
	});

	const radio = (value: Value) => document.querySelector<HTMLElement>(`[data-testid="seg-${value}"]`)!;
	const checked = () => OPTIONS.find((o) => radio(o.value).getAttribute("aria-checked") === "true")?.value;
	const tabStop = () => OPTIONS.filter((o) => radio(o.value).getAttribute("tabindex") === "0").map((o) => o.value);
	async function press(target: HTMLElement, key: string, modifiers: Record<string, boolean> = {}) {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key, ...modifiers });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	}

	it("ArrowRight/ArrowDown move focus to the next radio and choose it, and the tab stop follows", async () => {
		await mount("left");
		const event = await press(radio("left"), "ArrowRight");
		assert.equal(event.defaultPrevented, true);
		assert.deepEqual(changes, ["center"]);
		assert.equal(focused, radio("center"));
		assert.equal(checked(), "center");
		assert.deepEqual(tabStop(), ["center"]);
		await press(radio("center"), "ArrowDown");
		assert.deepEqual(changes, ["center", "right"]);
		assert.equal(focused, radio("right"));
		assert.deepEqual(tabStop(), ["right"]);
	});

	it("ArrowLeft/ArrowUp go back, and both directions wrap around the ends", async () => {
		await mount("left");
		await press(radio("left"), "ArrowLeft");
		assert.equal(checked(), "justify", "wraps from the first to the last");
		assert.equal(focused, radio("justify"));
		await press(radio("justify"), "ArrowRight");
		assert.equal(checked(), "left", "wraps from the last to the first");
		await press(radio("left"), "ArrowUp");
		assert.equal(checked(), "justify");
		assert.deepEqual(changes, ["justify", "left", "justify"]);
	});

	it("Home and End jump to the first and last radio", async () => {
		await mount("center");
		await press(radio("center"), "End");
		assert.equal(checked(), "justify");
		assert.equal(focused, radio("justify"));
		await press(radio("justify"), "Home");
		assert.equal(checked(), "left");
		assert.equal(focused, radio("left"));
	});

	it("handled keys do not reach document-level listeners; other keys and modified arrows pass through", async () => {
		await mount("left");
		await press(radio("left"), "ArrowRight");
		assert.deepEqual(documentKeys, [], "a quiz dock's global arrows must not also walk");
		for (const [key, modifiers] of [["a", {}], ["Enter", {}], ["ArrowRight", { shiftKey: true }], ["ArrowRight", { altKey: true }], ["ArrowRight", { metaKey: true }], ["ArrowRight", { ctrlKey: true }]] as const) {
			const event = await press(radio("center"), key, modifiers);
			assert.equal(event.defaultPrevented, false, `${key} ${JSON.stringify(modifiers)} is not ours`);
		}
		assert.deepEqual(changes, ["center"], "only the one handled arrow changed the value");
		assert.equal(checked(), "center");
	});

	it("a click still chooses, and re-clicking the chosen radio changes nothing", async () => {
		await mount("left");
		await act(async () => { radio("right").dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })); });
		assert.deepEqual(changes, ["right"]);
		await act(async () => { radio("right").dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })); });
		assert.deepEqual(changes, ["right"]);
		assert.deepEqual(tabStop(), ["right"]);
	});
});

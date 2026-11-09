import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// Stand-ins for browser behavior linkedom lacks: `oninput` on document (else React
// uses its old-IE input polyfill) and a bubbling `focusout` from blur() (what React's
// onBlur listens to).
(dom.document as unknown as { oninput: null }).oninput = null;
dom.window.HTMLInputElement.prototype.blur = function (this: HTMLInputElement) {
	this.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
};

// react-dom decides its input-event strategy at load, so it loads after the DOM stand-ins.
const { createRoot } = await import("react-dom/client");
const { CommitInput } = await import("../components/settings/controls.tsx");

let root: Root;
let commits: string[];

const input = () => document.querySelector("input") as HTMLInputElement;

async function type(text: string) {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()), "value")!.set!;
	await act(async () => {
		setter.call(input(), text);
		input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}

async function press(key: string) {
	await act(async () => {
		const event = new dom.window.Event("keydown", { bubbles: true });
		Object.assign(event, { key });
		input().dispatchEvent(event);
	});
}

beforeEach(async () => {
	commits = [];
	document.body.innerHTML = "<div id='root'></div>";
	root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<CommitInput value="" ariaLabel="background hex" onCommit={(next) => commits.push(next)} />);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
});

describe("CommitInput", () => {
	it("discards the typed text on Escape and shows the stored value", async () => {
		await type("#7a0000");
		assert.equal(input().value, "#7a0000");
		await press("Escape");
		assert.deepEqual(commits, []);
		assert.equal(input().value, "");
	});

	it("commits the typed text once on Enter", async () => {
		await type("#7a0000");
		await press("Enter");
		assert.deepEqual(commits, ["#7a0000"]);
	});

	it("commits the typed text once on blur", async () => {
		await type("#7a0000");
		await act(async () => input().blur());
		assert.deepEqual(commits, ["#7a0000"]);
	});
});

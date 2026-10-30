/**
 * The composer's attach button (issue #285): the picker's twin of a file
 * drop. Picked files become quoted path chips at the caret through the
 * desktop bridge; the browser build explains instead. Same linkedom
 * shims as file-path-drop-zone.test.tsx (no native Selection there).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";
import { pathsForFiles } from "../components/attach-files-button.tsx";
import { restorePathSelection } from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture({ desktop = true } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	const backingPaths = new Map<File, string>();
	let pickerClicks = 0;
	let byteReads = 0;
	let value = "readthis";
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", {
		configurable: true,
		value: desktop ? { getPathForFile: (file: File) => backingPaths.get(file) ?? "" } : undefined,
	});
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	function draw() {
		root.render(<Composer busy={false} value={value} onChange={(next) => { value = next; draw(); }} onSend={() => {}} onStop={() => {}} canSend />);
	}
	await act(async () => { draw(); });
	const picker = doc.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
	picker.click = () => { pickerClicks++; };
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>("[data-file-path-input]")!;
	return {
		button: doc.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!,
		get value() { return value; },
		get pickerClicks() { return pickerClicks; },
		get byteReads() { return byteReads; },
		file(name: string, path?: string) {
			const result = new File(["synthetic bytes must never be read"], name, { type: "application/pdf" });
			for (const method of ["text", "arrayBuffer", "stream"] as const) {
				Object.defineProperty(result, method, { value: () => { byteReads++; throw new Error("No file content reads"); } });
			}
			if (path !== undefined) backingPaths.set(result, path);
			return result;
		},
		caret(offset: number) {
			editor.focus();
			restorePathSelection(editor, { anchor: offset, focus: offset });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		async pick(files: File[]) {
			Object.defineProperty(picker, "files", { configurable: true, value: files });
			await act(async () => { picker.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
	};
}

describe("composer attach button", () => {
	it("pathsForFiles keeps rooted paths and skips files the bridge can't place", () => {
		const a = new File([""], "a.pdf");
		const b = new File([""], "b.png");
		const c = new File([""], "c.txt");
		const paths = new Map<File, string>([[a, "/notes/a.pdf"], [b, "relative/b.png"]]);
		const result = pathsForFiles([a, b, c], (file) => {
			const path = paths.get(file);
			if (!path) throw new Error("no path");
			return path;
		});
		assert.deepEqual(result, { paths: ["/notes/a.pdf"], skipped: 2 });
	});

	it("server render is the browser case: a disabled-looking paperclip, left of the input", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.match(html, /aria-label="Attach files"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Attach files"/);
		assert.ok(html.indexOf('data-testid="attach-files"') < html.indexOf("data-file-path-input"), "the button leads the input");
		assert.ok(html.includes('type="file"') && !html.includes("accept="), "any file type");
	});

	it("desktop: the button opens the picker and picked files become chips at the caret", async () => {
		const f = await fixture();
		assert.equal(f.button.getAttribute("aria-disabled"), "false");
		await act(async () => { f.button.click(); });
		assert.equal(f.pickerClicks, 1);
		f.caret(4);
		const paths = ["/course/week 3.pdf", "/photos/board.jpg"];
		await f.pick([f.file("week 3.pdf", paths[0]), f.file("board.jpg", paths[1]), f.file("virtual.pdf")]);
		assert.equal(f.value, `read ${paths.map(quoteFilePath).join(" ")} this`);
		assert.equal(f.byteReads, 0, "paths only — file contents are never read");
	});

	it("browser: the button stays inert and the picker never opens", async () => {
		const f = await fixture({ desktop: false });
		assert.equal(f.button.getAttribute("aria-disabled"), "true");
		await act(async () => { f.button.click(); });
		assert.equal(f.pickerClicks, 0);
		await f.pick([f.file("a.pdf", "/a.pdf")]);
		assert.equal(f.value, "readthis");
	});
});

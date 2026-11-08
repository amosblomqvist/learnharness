/**
 * Browser attachments (LAN web access, S4): without the desktop bridge the
 * attach button picks files and the drop zone accepts drops, both upload to
 * POST /api/uploads and chip the returned host path through
 * INSERT_FILE_PATHS_EVENT. Desktop keeps native paths and never uploads.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AttachFilesButton } from "../components/attach-files-button.tsx";
import { FilePathDropZone } from "../components/file-path-drop-zone.tsx";
import { INSERT_FILE_PATHS_EVENT } from "../components/path-input.tsx";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture({ desktop = false, failUploads = false } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 40, top: 600, bottom: 640, width: 40, height: 40, toJSON() {} });
	const requests: { url: string; init: RequestInit }[] = [];
	const inserted: string[][] = [];
	let pickerClicks = 0;
	const uploadFetch = async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		if (failUploads) return Response.json({ error: "disk full" }, { status: 500 });
		return Response.json({ path: `/data/uploads/2026-11-05/abc123-${decodeURIComponent((init.headers as Record<string, string>)["x-file-name"] ?? "")}` });
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1000, innerHeight: 800, fetch: uploadFetch,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", { configurable: true, value: desktop ? { getPathForFile: (file: File) => `/native/${file.name}`, chooseAttachmentFolder: async () => null } : undefined });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	function Harness() {
		const editorRef = React.useRef<HTMLDivElement>(null);
		return <FilePathDropZone>
			<div ref={editorRef} data-file-path-input="" data-testid="editor" tabIndex={0} />
			<AttachFilesButton editorRef={editorRef} />
		</FilePathDropZone>;
	}
	await act(async () => { root.render(<Harness />); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>('[data-testid="editor"]')!;
	editor.addEventListener(INSERT_FILE_PATHS_EVENT, (e) => inserted.push((e as CustomEvent<string[]>).detail));
	const picker = doc.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
	picker.click = () => { pickerClicks++; };
	const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	return {
		doc, requests, inserted, picker, editor,
		button: doc.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!,
		get pickerClicks() { return pickerClicks; },
		get status() { return doc.querySelector('[role="status"]')?.textContent ?? ""; },
		async pick(files: File[]) {
			Object.defineProperty(picker, "files", { configurable: true, value: files });
			await act(async () => { picker.dispatchEvent(new win.Event("change", { bubbles: true })); });
			await settle();
		},
		async drop(files: File[], directories: number[] = []) {
			const dataTransfer = {
				types: ["Files"], files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
				items: files.map((file, i) => ({ kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directories.includes(i) }) })),
			};
			const event = Object.assign(new win.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer });
			await act(async () => { doc.querySelector('[data-testid="file-path-drop-zone"]')!.dispatchEvent(event); });
			await settle();
		},
	};
}

test("browser: the attach button is enabled, opens the native picker, and uploads each picked file", async () => {
	const f = await fixture();
	assert.equal(f.button.getAttribute("aria-disabled"), "false");
	await act(async () => { f.button.click(); });
	assert.equal(f.pickerClicks, 1);
	assert.equal(f.doc.querySelector('[role="menu"]'), null, "no Files/Folder menu in the browser");
	await f.pick([new File(["one"], "a b.pdf"), new File(["two"], "c.txt")]);
	assert.equal(f.requests.length, 2, "one request per file");
	assert.equal(f.requests[0]!.url, "/api/uploads");
	assert.equal(f.requests[0]!.init.method, "POST");
	assert.equal((f.requests[0]!.init.headers as Record<string, string>)["x-file-name"], "a%20b.pdf");
	assert.deepEqual(f.inserted, [["/data/uploads/2026-11-05/abc123-a b.pdf", "/data/uploads/2026-11-05/abc123-c.txt"]]);
	assert.equal(f.status, "");
	assert.equal(f.picker.value, "");
});

test("browser: a file over the limit is refused before sending, with a message naming the limit", async () => {
	const f = await fixture();
	const big = new File(["x"], "huge.bin");
	Object.defineProperty(big, "size", { value: MAX_IMPORT_BODY_BYTES + 1 });
	await f.pick([big, new File(["ok"], "ok.txt")]);
	assert.equal(f.requests.length, 1, "only the small file is sent");
	assert.match(f.status, /huge\.bin/);
	assert.match(f.status, /26 MiB/);
	assert.deepEqual(f.inserted, [["/data/uploads/2026-11-05/abc123-ok.txt"]]);
});

test("browser: a failed upload shows the error and inserts nothing", async () => {
	const f = await fixture({ failUploads: true });
	await f.pick([new File(["one"], "a.pdf")]);
	assert.match(f.status, /Could not upload a\.pdf: disk full/);
	assert.deepEqual(f.inserted, []);
});

test("browser: dropping files uploads them and appends the returned paths instead of showing the desktop notice", async () => {
	const f = await fixture();
	f.editor.focus();
	await f.drop([new File(["one"], "dropped.md"), new File([""], "folder")], [1]);
	assert.equal(f.requests.length, 1, "directories are skipped");
	assert.deepEqual(f.inserted, [["/data/uploads/2026-11-05/abc123-dropped.md"]]);
	assert.doesNotMatch(f.status, /desktop app/);
});

test("desktop: native paths are used and nothing is uploaded", async () => {
	const f = await fixture({ desktop: true });
	await act(async () => { f.button.click(); });
	assert.equal(f.pickerClicks, 0, "desktop opens the Files/Folder menu first");
	assert.deepEqual(Array.from(f.doc.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent), ["Files", "Folder"]);
	await f.pick([new File(["one"], "a.pdf")]);
	assert.deepEqual(f.inserted, [["/native/a.pdf"]]);
	assert.equal(f.requests.length, 0);
});

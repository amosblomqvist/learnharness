import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { FilePathDropZone } from "../components/file-path-drop-zone.tsx";
import { useDictationTarget } from "../components/dictation.tsx";
import { PathInput } from "../components/path-input.tsx";
import { readPathInput, restorePathSelection } from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** No native DataTransfer/Selection in linkedom. These shims exercise React's
 * real bubbling handlers and the editor's logical caret contract, not OS drag. */
async function fixture({ desktop = true, claimed = true } = {}) {
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
	const resolved: File[] = [];
	const backingPaths = new Map<File, string | Error>();
	const appends: string[] = [];
	let byteReads = 0;
	let uploads = 0;
	let submits = 0;
	let keys = 0;
	let value = "readthis";
	const bridge = desktop ? { getPathForFile(file: File) {
		resolved.push(file);
		const result = backingPaths.get(file);
		if (result instanceof Error) throw result;
		return result ?? "";
	} } : undefined;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: () => { uploads++; throw new Error("No network expected for file drops"); },
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const oldBridge = Object.getOwnPropertyDescriptor(win, "lh");
	Object.defineProperty(win, "lh", { configurable: true, value: bridge });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	function Harness() {
		useDictationTarget((text) => appends.push(text), claimed);
		return <>
			<aside data-testid="sidebar">Sidebar</aside>
			<FilePathDropZone>
				<form onSubmit={(event) => { event.preventDefault(); submits++; }}>
					<PathInput data-testid="editor" value={value} onValueChange={(next) => { value = next; draw(); }} onKeyDown={() => { keys++; }} />
					<button type="button" data-testid="elsewhere">Elsewhere</button>
					<div data-testid="content">Content away from the input</div>
				</form>
			</FilePathDropZone>
		</>;
	}
	function draw() { root.render(<Harness />); }
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		if (oldBridge) Object.defineProperty(win, "lh", oldBridge);
		else delete (win as unknown as Record<string, unknown>).lh;
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>('[data-testid="editor"]')!;
	function file(name: string, path?: string | Error) {
		const result = new File(["synthetic bytes must never be read"], name, { type: "application/pdf" });
		for (const method of ["text", "arrayBuffer", "stream"] as const) {
			Object.defineProperty(result, method, { value: () => { byteReads++; throw new Error("No file content reads"); } });
		}
		if (path !== undefined) backingPaths.set(result, path);
		return result;
	}
	function transfer(files: File[], directories: number[] = [], types = ["Files"]) {
		return {
			types,
			files: Object.assign([...files], { item: (index: number) => files[index] ?? null }),
			items: files.map((file, index) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directories.includes(index), isFile: !directories.includes(index) }) })),
			dropEffect: "none",
		};
	}
	async function event(type: string, dataTransfer = transfer([]), target: Element = doc.querySelector('[data-testid="content"]')!) {
		const event = Object.assign(new win.Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	}
	return {
		doc, editor, appends, resolved, file, transfer, event,
		get value() { return value; },
		get status() { return doc.querySelector('[role="status"]')?.textContent ?? ""; },
		focusEditor(offset: number) {
			editor.focus();
			restorePathSelection(editor, { anchor: offset, focus: offset });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		assertPathOnly() { assert.equal(byteReads, 0); assert.equal(uploads, 0); assert.equal(submits, 0); assert.equal(keys, 0); },
	};
}

test("desktop drop inserts quoted paths at the focused editor caret instead of the dictation claimant", async () => {
	const f = await fixture();
	f.focusEditor(4);
	const paths = ["/actual/course notes.pdf", "C:\\course\\chapter`one.pdf", "\\\\host\\share\\図.png"];
	const files = paths.map((path, index) => f.file(`display-name-${index}.pdf`, path));
	const dropped = await f.event("drop", f.transfer(files));
	assert.equal(dropped.defaultPrevented, true);
	assert.equal(f.value, `read ${paths.map(quoteFilePath).join(" ")} this`);
	assert.equal(readPathInput(f.editor), f.value);
	assert.equal(f.doc.activeElement, f.editor);
	assert.deepEqual(f.appends, [], "focused editor wins over the registered question field");
	assert.deepEqual(f.resolved, files, "only Electron's full path, never File.name, enters the draft");
	assert.equal(f.status, "", "successful file attachment is silent");
	f.assertPathOnly();
});

test("a successful drop clears an earlier failure without replacing it with a confirmation bubble", async () => {
	const f = await fixture();
	await f.event("drop", f.transfer([f.file("virtual.pdf")]));
	assert.match(f.status, /No local file paths were available/);
	await f.event("drop", f.transfer([f.file("valid.pdf", "/existing/valid.pdf")]));
	assert.deepEqual(f.appends, ["`/existing/valid.pdf`"]);
	assert.equal(f.doc.querySelector('[role="status"]'), null);
	f.assertPathOnly();
});

test("unfocused drop uses the dictation target registry, not the last focused editor", async () => {
	const f = await fixture();
	f.focusEditor(4);
	f.doc.querySelector<HTMLElement>('[data-testid="elsewhere"]')!.focus();
	const paths = ["~/notes one.pdf", "/tmp/notes`final`"];
	await f.event("drop", f.transfer(paths.map((path) => f.file("not-a-physical-path.pdf", path))));
	assert.deepEqual(f.appends, [paths.map(quoteFilePath).join(" ")]);
	assert.equal(f.value, "readthis", "saved editor caret must not override current default target");
	f.assertPathOnly();
});

test("browser drop prevents navigation, explains desktop-only local paths and never infers File.name", async () => {
	const f = await fixture({ desktop: false });
	const transfer = f.transfer([f.file("/not/a/backing/path.pdf")]);
	const enter = await f.event("dragenter", transfer);
	assert.equal(enter.defaultPrevented, true);
	assert.match(f.doc.querySelector('[data-testid="file-path-drop-indicator"]')!.textContent!, /desktop app/);
	const over = await f.event("dragover", transfer);
	assert.equal(over.defaultPrevented, true);
	assert.equal(transfer.dropEffect, "copy");
	const drop = await f.event("drop", transfer);
	assert.equal(drop.defaultPrevented, true);
	assert.match(f.status, /Local file paths can only be attached in the desktop app/);
	assert.match(f.status, /paste a full path instead/);
	assert.equal(f.doc.querySelector('[data-testid="file-path-drop-indicator"]'), null);
	assert.equal(f.value, "readthis");
	assert.deepEqual(f.appends, []);
	assert.deepEqual(f.resolved, []);
	f.assertPathOnly();
});

test("invalid, virtual and directory items are skipped while valid backing paths stay ordered", async () => {
	const f = await fixture();
	const files = [
		f.file("virtual.pdf"), f.file("bad.pdf", "relative.pdf"), f.file("broken.pdf", new Error("not backed")),
		f.file("folder", "/directory"), f.file("valid.pdf", "/existing/valid.pdf"),
		f.file("multiline.pdf", "/a\nb.pdf"), f.file("NUL.pdf", "/a\0b.pdf"), f.file("url.pdf", "file:///a.pdf"),
	];
	await f.event("drop", f.transfer(files, [3]));
	assert.deepEqual(f.appends, ["`/existing/valid.pdf`"]);
	assert.equal(f.resolved.includes(files[3]!), false, "directory metadata prevents resolving a folder");
	assert.match(f.status, /Some dropped items had no available file path/);
	f.assertPathOnly();
});

test("a drop with no backing paths or no destination has a truthful notice and stages nothing", async () => {
	const f = await fixture({ claimed: false });
	const missing = await f.event("drop", f.transfer([f.file("virtual.pdf")]));
	assert.equal(missing.defaultPrevented, true);
	assert.match(f.status, /No local file paths were available/);
	await f.event("drop", f.transfer([f.file("valid.pdf", "/existing/valid.pdf")]));
	assert.match(f.status, /Open a chat to attach file paths/);
	assert.deepEqual(f.appends, []);
	assert.equal(f.value, "readthis");
	f.assertPathOnly();
});

test("non-file drags stay native; sidebar file drops prevent navigation without attaching", async () => {
	const f = await fixture();
	const plain = f.transfer([], [], ["text/plain"]);
	for (const type of ["dragenter", "dragover", "drop"]) {
		assert.equal((await f.event(type, plain)).defaultPrevented, false);
	}
	const sidebar = f.doc.querySelector('[data-testid="sidebar"]')!;
	assert.equal((await f.event("drop", f.transfer([f.file("notes.pdf", "/existing/notes.pdf")]), sidebar)).defaultPrevented, true);
	assert.deepEqual(f.resolved, []);
	assert.deepEqual(f.appends, []);
	assert.equal(f.status, "");
	f.assertPathOnly();
});

test("nested enter/leave depth keeps the drop overlay until the zone is left; notice is dismissible", async () => {
	const f = await fixture({ desktop: false });
	const transfer = f.transfer([f.file("notes.pdf")]);
	await f.event("dragenter", transfer);
	await f.event("dragenter", transfer);
	await f.event("dragleave", transfer);
	assert.ok(f.doc.querySelector('[data-testid="file-path-drop-indicator"]'));
	await f.event("dragleave", transfer);
	assert.equal(f.doc.querySelector('[data-testid="file-path-drop-indicator"]'), null);
	await f.event("drop", transfer);
	assert.notEqual(f.status, "");
	await act(async () => { f.doc.querySelector<HTMLElement>('[aria-label="Dismiss attachment notice"]')!.click(); });
	assert.equal(f.status, "");
	f.assertPathOnly();
});

test("production AppShell places the sidebar outside its content-only drop zone", () => {
	const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
	const shell = source.slice(source.indexOf("export function AppShell("));
	assert.match(shell, /<SessionsSidebar\s*\/>\s*<FilePathDropZone\b[^>]*>\{children\}<\/FilePathDropZone>/);
	assert.doesNotMatch(shell, /<FilePathDropZone\b[^>]*>[\s\S]*<SessionsSidebar/);
});

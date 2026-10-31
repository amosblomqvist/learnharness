import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { PathInput, INSERT_FILE_PATHS_EVENT } from "../components/path-input.tsx";
import {
	PATH_CARET_ATTRIBUTE, PATH_SOURCE_ATTRIBUTE, PathInputHistory, adjacentPathRange, atomicPathRange,
	insertFilePaths, normalizePathEdit, normalizePathInputValue, pathInputOffset, pathInputPoint, pathInputStaticRange, readPathInput,
	readPathSelection, renderPathInput, replacePathSelection, restorePathSelection,
} from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";

function editor() {
	const { document } = parseHTML("<html><body><div id='editor'></div></body></html>");
	return document.getElementById("editor")!;
}

test("DOM projection is lossless across whitespace, Unicode and all rooted path forms", () => {
	const root = editor();
	const paths = ["/a/notes one.pdf", "C:\\a\\notes.pdf", "\\\\host\\share\\sheet.csv", "~/notes`final`.pdf"];
	const value = `  👩🏽‍💻\t中\n${paths.map(quoteFilePath).join("\n\t")}\n \n`;
	const hosts = renderPathInput(root, value);
	assert.equal(hosts.length, paths.length);
	for (const { host } of hosts) {
		host.textContent = "abbreviated.pdf";
		assert.equal(host.getAttribute("contenteditable"), "false");
	}
	assert.equal(readPathInput(root), value);
	assert.equal(root.dataset.empty, "false");
	renderPathInput(root, "");
	assert.equal(readPathInput(root), "");
	assert.equal(root.dataset.empty, "true");
});

test("logical offsets round-trip across text, adjacent chips, line breaks and reversed selections", () => {
	const root = editor();
	const value = `🙂A ${quoteFilePath("/one")} ${quoteFilePath("/two")}\nend`;
	renderPathInput(root, value);
	for (let offset = 0; offset <= value.length; offset++) {
		const point = pathInputPoint(root, offset);
		const mapped = pathInputOffset(root, point.node, point.offset)!;
		const token = Array.from(root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`)).find((host) => {
			const start = value.indexOf(host.getAttribute(PATH_SOURCE_ATTRIBUTE)!);
			return offset > start && offset < start + host.getAttribute(PATH_SOURCE_ATTRIBUTE)!.length;
		});
		if (!token) assert.equal(mapped, offset, `offset ${offset}`);
		else {
			const raw = token.getAttribute(PATH_SOURCE_ATTRIBUTE)!;
			const start = value.indexOf(raw);
			assert.ok(mapped === start || mapped === start + raw.length);
		}
	}
	assert.equal(pathInputOffset(root, root.ownerDocument.body, 0), null);
});

test("BR/block fallback never reads visual labels or normalizes ordinary spaces", () => {
	const root = editor();
	root.innerHTML = "<div> a  </div><div><br></div><div>b</div>";
	assert.equal(readPathInput(root), " a  \n\nb");
	root.innerHTML = "<br>";
	assert.equal(readPathInput(root), "");
	root.innerHTML = "a<br>b";
	assert.equal(readPathInput(root), "a\nb");
});

test("trailing newline caret placeholder is presentation-only and logical end maps before it", () => {
	const root = editor();
	for (const value of ["\n", "\n\n", "one\n", "one\n\n", "one\n\n\n"]) {
		renderPathInput(root, value);
		assert.equal(root.querySelectorAll(`[${PATH_CARET_ATTRIBUTE}]`).length, 1);
		assert.equal(root.lastElementChild?.tagName, "BR");
		assert.equal(root.lastElementChild?.getAttribute("aria-hidden"), "true");
		assert.equal(root.textContent, value);
		assert.equal(readPathInput(root), value);
		const point = pathInputPoint(root, value.length);
		assert.equal(point.node, root);
		assert.equal(point.offset, root.childNodes.length - 1);
		assert.equal(pathInputOffset(root, point.node, point.offset), value.length);
		assert.equal(pathInputOffset(root, root.lastChild!, 0), value.length);
	}
	for (const value of ["", "one", "one\ntwo"]) {
		renderPathInput(root, value);
		assert.equal(root.querySelector(`[${PATH_CARET_ATTRIBUTE}]`), null);
		assert.equal(readPathInput(root), value);
	}
});

test("range replacement/deletion is atomic and leaves neighboring whitespace untouched", () => {
	const token = quoteFilePath("/course/notes.pdf");
	const value = `a ${token} b`;
	assert.deepEqual(atomicPathRange(value, { anchor: 5, focus: 1 }), { start: 1, end: 2 + token.length });
	assert.equal(replacePathSelection(value, { anchor: 3, focus: 8 }, "").value, "a  b");
	assert.deepEqual(adjacentPathRange(value, { anchor: 2, focus: 2 }, "forward"), { anchor: 2, focus: 2 + token.length });
	assert.deepEqual(adjacentPathRange(value, { anchor: 2 + token.length, focus: 2 + token.length }, "backward"), { anchor: 2, focus: 2 + token.length });
	assert.equal(adjacentPathRange(value, { anchor: 1, focus: 1 }, "forward"), null);
});

test("file insertion uses full quoted sources at saved ranges with separating spaces", () => {
	const next = insertFilePaths("readthis", { anchor: 4, focus: 4 }, ["/a b.pdf", "C:\\a\\x.txt"]);
	assert.equal(next.value, "read `/a b.pdf` `C:\\a\\x.txt` this");
	assert.equal(next.selection.anchor, next.value.length - 4);
	assert.equal(insertFilePaths("a\n", { anchor: 2, focus: 2 }, ["~/x"]).value, "a\n`~/x`");
	assert.throws(() => insertFilePaths("", { anchor: 0, focus: 0 }, ["relative.txt"]), TypeError);
});

test("owned history restores values and directional selections; a new edit discards redo", () => {
	const history = new PathInputHistory();
	const a = { value: "a", selection: { anchor: 1, focus: 0 } };
	const b = { value: "ab", selection: { anchor: 2, focus: 2 } };
	history.push(a);
	assert.deepEqual(history.undo(b), a);
	assert.deepEqual(history.redo(a), b);
	history.undo(b);
	history.push(a);
	assert.equal(history.redo(b), null);
	history.reset();
	assert.equal(history.undo(b), null);
});

test("textbox exposes accessibility, placeholder, global-drop markers and requested sizing", () => {
	const html = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} placeholder="Ask" aria-label="Message" defaultDropTarget className="min-h-24 max-h-64" />);
	for (const pattern of [/role="textbox"/, /aria-multiline="true"/, /aria-label="Message"/, /data-file-path-input=""/, /data-file-path-default=""/, /data-placeholder="Ask"/, /min-h-24 max-h-64/]) assert.match(html, pattern);
});

test("SSR preserves the full escaped initial draft without waiting for client effects", () => {
	const draft = "  Restored <reasoning> & notes\n`/course/full notes.pdf`\n ";
	const html = renderToStaticMarkup(<PathInput value={draft} onValueChange={() => assert.fail("SSR cannot emit changes")} placeholder="Reasoning" />);
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	const field = document.querySelector('[data-file-path-input]')!;
	assert.equal(field.textContent, draft);
	assert.equal(field.getAttribute("contenteditable") ?? field.getAttribute("contentEditable"), "true");
	assert.equal(field.getAttribute("data-empty"), "false");
	assert.equal(field.querySelector("reasoning"), null);
	assert.match(html, /&lt;reasoning&gt;/);
	const single = renderToStaticMarkup(<PathInput singleLine value={"one\r\ntwo"} onValueChange={() => {}} />);
	assert.equal(parseHTML(`<html><body>${single}</body></html>`).document.body.textContent, "onetwo");
});

test("textbox accessible name falls back to placeholder and preserves explicit aria-label", () => {
	const fallback = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} placeholder="Your reasoning" />);
	assert.match(fallback, /aria-label="Your reasoning"/);
	const explicit = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} placeholder="Your reasoning" aria-label="Custom answer" />);
	assert.match(explicit, /aria-label="Custom answer"/);
	assert.doesNotMatch(explicit, /aria-label="Your reasoning"/);
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** linkedom has no Selection/default editing actions. The shim tests our offset
 * contract, NOT browser caret navigation or the native IME implementation. */
async function fixture(initial: string, singleLine = false) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div><button id='elsewhere'></button></body></html>");
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
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const reactRoot = createRoot(doc.getElementById("root")!);
	const ref = React.createRef<HTMLDivElement>();
	let value = initial;
	const writes: string[] = [];
	let keys = 0;
	function draw() {
		reactRoot.render(<PathInput ref={ref} singleLine={singleLine} value={value} onValueChange={(next) => { writes.push(next); value = next; draw(); }} onKeyDown={() => { keys++; }} />);
	}
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { reactRoot.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const root = ref.current!;
	root.focus();
	function select(anchor: number, focus = anchor) {
		restorePathSelection(root, { anchor, focus });
		doc.dispatchEvent(new win.Event("selectionchange"));
	}
	async function event(type: string, properties: Record<string, unknown> = {}) {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, properties);
		await act(async () => { root.dispatchEvent(event); });
		return event;
	}
	return {
		root, doc, select, event, writes, selection,
		get value() { return value; }, get keys() { return keys; },
		async external(next: string) { await act(async () => { value = next; draw(); }); },
		async nativeText(next: string, inputType = "insertText") {
			await event("beforeinput", { inputType, isComposing: false });
			root.replaceChildren(doc.createTextNode(next));
			select(next.length);
			await event("input", { inputType });
		},
	};
}

test("native typing, token insertion/deletion and undo/redo share one history", async () => {
	const f = await fixture("a");
	f.select(1);
	await f.nativeText("ab");
	await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/notes.pdf"] });
	assert.equal(f.value, "ab `/notes.pdf`");
	assert.match(f.root.textContent!, /notes.pdf/);
	await f.event("keydown", { key: "Backspace" });
	assert.equal(f.value, "ab ");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "ab `/notes.pdf`");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "ab");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "a");
	await f.event("beforeinput", { inputType: "historyRedo" });
	assert.equal(f.value, "ab");
});

test("Cmd+Backspace delegates line extent to beforeinput instead of deleting just the final chip", async () => {
	const source = "Explain `/tmp/notes.pdf`";
	const f = await fixture(source);
	f.select(source.length);
	const key = await f.event("keydown", { key: "Backspace", metaKey: true });
	assert.equal(key.defaultPrevented, false);
	assert.equal(f.value, source);
	const deletion = await f.event("beforeinput", {
		inputType: "deleteSoftLineBackward",
		getTargetRanges: () => [{ startContainer: f.root.firstChild!, startOffset: 0, endContainer: f.root, endOffset: f.root.childNodes.length }],
	});
	assert.equal(deletion.defaultPrevented, true);
	assert.equal(f.value, "");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, source);
	assert.deepEqual(readPathSelection(f.root), { anchor: source.length, focus: source.length });
});

test("native word and soft/hard line deletion ranges retain mixed text/chip extents in both directions", async () => {
	const source = "keep old `/tmp/notes.pdf` tail\nnext";
	const f = await fixture(source);
	const lineEnd = source.indexOf("\n");
	const chipEnd = source.indexOf(" tail");
	const cases = [
		["deleteWordBackward", 5, lineEnd], ["deleteWordForward", 5, chipEnd],
		["deleteSoftLineBackward", 0, lineEnd], ["deleteSoftLineForward", 5, lineEnd],
		["deleteHardLineBackward", 0, chipEnd], ["deleteHardLineForward", 5, lineEnd],
	] as const;
	for (const [inputType, start, end] of cases) {
		await f.external(source);
		const backward = inputType.endsWith("Backward");
		f.select(backward ? end : start);
		const key = await f.event("keydown", { key: backward ? "Backspace" : "Delete", ctrlKey: true });
		assert.equal(key.defaultPrevented, false, inputType);
		assert.equal(f.value, source);
		const a = pathInputPoint(f.root, start);
		const b = pathInputPoint(f.root, end);
		const deletion = await f.event("beforeinput", {
			inputType,
			getTargetRanges: () => [{ startContainer: a.node, startOffset: a.offset, endContainer: b.node, endOffset: b.offset }],
		});
		assert.equal(deletion.defaultPrevented, true, inputType);
		assert.equal(f.value, source.slice(0, start) + source.slice(end), inputType);
		assert.deepEqual(readPathSelection(f.root), { anchor: start, focus: start });
	}
});

test("deleteEntireSoftLine honors the browser extent and never substitutes a chip when ranges are absent", async () => {
	const source = "before\nExplain `/tmp/notes.pdf` tail\nafter";
	const f = await fixture(source);
	const start = source.indexOf("Explain");
	const end = source.indexOf("\nafter");
	f.select(source.indexOf("`")); // Adjacent to a chip, but not a chip-only command.
	for (const getTargetRanges of [undefined, () => []]) {
		const missing = await f.event("beforeinput", { inputType: "deleteEntireSoftLine", getTargetRanges });
		assert.equal(missing.defaultPrevented, false);
		assert.equal(f.value, source);
	}
	const a = pathInputPoint(f.root, start);
	const b = pathInputPoint(f.root, end);
	const deletion = await f.event("beforeinput", {
		inputType: "deleteEntireSoftLine",
		getTargetRanges: () => [{ startContainer: a.node, startOffset: a.offset, endContainer: b.node, endOffset: b.offset }],
	});
	assert.equal(deletion.defaultPrevented, true);
	assert.equal(f.value, "before\n\nafter");
	assert.deepEqual(readPathSelection(f.root), { anchor: start, focus: start });
});

test("browser target ranges that intersect a visual chip interior expand the complete source atomically", async () => {
	const source = "keep old `/tmp/notes.pdf` tail";
	const f = await fixture(source);
	f.select(5);
	const label = f.root.querySelector(`[${PATH_SOURCE_ATTRIBUTE}] [role=img] span`)!.firstChild!;
	const start = pathInputPoint(f.root, 5);
	const target = { startContainer: start.node, startOffset: start.offset, endContainer: label, endOffset: 2 };
	const mapped = pathInputStaticRange(f.root, target)!;
	assert.ok(mapped.focus > source.indexOf("`"));
	assert.ok(mapped.focus < source.lastIndexOf("`") + 1);
	await f.event("beforeinput", { inputType: "deleteWordForward", getTargetRanges: () => [target] });
	assert.equal(f.value, "keep  tail");
	assert.equal(f.root.querySelector(`[${PATH_SOURCE_ATTRIBUTE}]`), null);
});

test("missing or invalid word/line target ranges defer to native editing and preserve owned undo", async () => {
	const source = "Explain `/tmp/notes.pdf`";
	const f = await fixture(source);
	f.select(source.length);
	for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
		for (const key of ["Backspace", "Delete"]) {
			const event = await f.event("keydown", { key, [modifier]: true });
			assert.equal(event.defaultPrevented, false);
			assert.equal(f.value, source);
		}
	}
	for (const inputType of ["deleteWordBackward", "deleteWordForward", "deleteSoftLineBackward", "deleteSoftLineForward", "deleteHardLineBackward", "deleteHardLineForward"]) {
		for (const getTargetRanges of [undefined, () => []]) {
			const beforeInput = await f.event("beforeinput", { inputType, getTargetRanges });
			assert.equal(beforeInput.defaultPrevented, false, `${inputType} must not fall through to adjacent-chip deletion`);
			assert.equal(f.value, source);
		}
	}
	const valid = { startContainer: f.root, startOffset: 0, endContainer: f.root, endOffset: f.root.childNodes.length };
	for (const getTargetRanges of [
		undefined, () => [], () => [{ ...valid, startContainer: f.doc.body }],
		() => [{ ...valid, startOffset: -1 }], () => [{ ...valid, endOffset: 999 }],
		() => [{ ...valid, endOffset: 0 }], () => [valid, valid], () => { throw new Error("not available"); },
	]) {
		const beforeInput = await f.event("beforeinput", { inputType: "deleteWordBackward", getTargetRanges });
		assert.equal(beforeInput.defaultPrevented, false);
		assert.equal(f.value, source);
	}
	// With no usable target ranges the browser edits the DOM, then input projects it.
	await f.nativeText("", "deleteHardLineBackward");
	assert.equal(f.value, "");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, source);
});

test("ordinary backward/forward chip deletion and selected ranges retain their existing behavior", async () => {
	const source = "a `/tmp/notes.pdf` b";
	const f = await fixture(source);
	f.select(source.length - 2);
	const backspace = await f.event("keydown", { key: "Backspace" });
	assert.equal(backspace.defaultPrevented, true);
	assert.equal(f.value, "a  b");
	await f.external(source);
	f.select(2);
	const forward = await f.event("keydown", { key: "Delete" });
	assert.equal(forward.defaultPrevented, true);
	assert.equal(f.value, "a  b");
	await f.external(source);
	f.select(source.length, 0);
	const selected = await f.event("keydown", { key: "Backspace" });
	assert.equal(selected.defaultPrevented, true);
	assert.equal(f.value, "");
});

test("immutable SSR fallback never stomps native edits, controlled updates, chips or reset", async () => {
	const initial = "Restored draft `/course/original.pdf`";
	const f = await fixture(initial);
	assert.equal(readPathInput(f.root), initial);
	assert.equal(f.root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`).length, 1);
	f.select(initial.length);
	await f.nativeText("New typed draft");
	assert.equal(readPathInput(f.root), "New typed draft");
	assert.equal(f.root.textContent, "New typed draft");
	await f.external("Controlled `/course/replaced.pdf`");
	assert.equal(readPathInput(f.root), "Controlled `/course/replaced.pdf`");
	assert.equal(f.root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`).length, 1);
	assert.doesNotMatch(f.root.textContent!, /Restored draft/);
	await f.external("");
	await f.external(""); // Re-render again with the same initial fallback child prop.
	assert.equal(readPathInput(f.root), "");
	assert.equal(f.root.textContent, "");
	assert.equal(f.root.dataset.empty, "true");
});

test("external dictation append/reset and drop at an unfocused saved selection", async () => {
	const f = await fixture("one two");
	f.select(3);
	f.doc.getElementById("elsewhere")!.focus();
	await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/notes one.pdf"] });
	assert.equal(f.value, "one `/notes one.pdf` two");
	assert.equal(f.doc.activeElement, f.root);
	assert.equal(f.keys, 0, "staging must not submit");
	f.select(f.value.length);
	await f.external(`${f.value}\nspoken words`);
	assert.equal(readPathInput(f.root), f.value);
	await f.event("keydown", { key: "z", ctrlKey: true });
	assert.equal(f.value, "one `/notes one.pdf` two");
	await f.external("");
	assert.equal(readPathInput(f.root), "");
	await f.event("keydown", { key: "z", ctrlKey: true });
	assert.equal(f.value, "");
});

test("plaintext paste ignores HTML and copy/cut use full token source in either direction", async () => {
	const source = "read `/deep/course/notes.pdf` now";
	const f = await fixture(source);
	f.select(source.length - 4, 5);
	const clipboard = new Map<string, string>();
	const clipboardData = { setData: (type: string, text: string) => clipboard.set(type, text), getData: (type: string) => type === "text/plain" ? "<img src=x onerror=alert(1)>\n中" : "<b>unsafe HTML</b>" };
	await f.event("copy", { clipboardData });
	assert.equal(clipboard.get("text/plain"), "`/deep/course/notes.pdf`");
	await f.event("cut", { clipboardData });
	assert.equal(f.value, "read  now");
	f.select(5);
	await f.event("paste", { clipboardData });
	assert.equal(f.value, "read <img src=x onerror=alert(1)>\n中 now");
	assert.equal(f.root.querySelector("img"), null);
	assert.equal(readPathInput(f.root), f.value);
});

test("image/file-only paste prevents native insertion without deleting selected text or chips", async () => {
	const source = "plain `/course/notes.pdf` end";
	const f = await fixture(source);
	const clipboardData = { types: ["Files", "image/png"], getData: () => "" };
	for (const [anchor, focus] of [[0, 5], [6, source.length - 4]]) {
		f.select(anchor!, focus!);
		const paste = await f.event("paste", { clipboardData });
		assert.equal(paste.defaultPrevented, true);
		assert.equal(f.value, source);
		assert.equal(readPathInput(f.root), source);
	}
	assert.deepEqual(f.writes, []);
	assert.equal(f.root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`).length, 1);
});

test("empty clipboard text stays a no-op before, during and after IME with a chip selected", async () => {
	const source = "a `/course/notes.pdf` z";
	const f = await fixture(source);
	f.select(2, source.length - 2);
	const clipboardData = { getData: () => "", types: ["text/html"] };
	await f.event("paste", { clipboardData });
	await f.event("compositionstart");
	const during = await f.event("paste", { clipboardData });
	assert.equal(during.defaultPrevented, true);
	assert.equal(readPathInput(f.root), source);
	await f.event("compositionend");
	assert.equal(readPathInput(f.root), source, "no empty pending paste can remove the selected chip");
	await f.event("paste", { clipboardData });
	assert.equal(f.value, source);
	assert.deepEqual(f.writes, []);
});

test("Shift+Delete delegates to cut, preserving full-source clipboard and deleting only once", async () => {
	const f = await fixture("plain`/next.pdf`");
	for (const [source, selected] of [["plain`/next.pdf`", "plain"], ["`/course/notes.pdf` `/next.pdf`", "`/course/notes.pdf` "]] as const) {
		await f.external(source);
		f.select(0, selected.length);
		const key = await f.event("keydown", { key: "Delete", shiftKey: true });
		assert.equal(key.defaultPrevented, false, "native Cut shortcut must reach the browser");
		assert.equal(f.value, source, "keydown alone must not delete the selection");
		let copied = "";
		const cut = await f.event("cut", { clipboardData: { setData: (type: string, value: string) => { assert.equal(type, "text/plain"); copied = value; } } });
		assert.equal(cut.defaultPrevented, true);
		assert.equal(copied, selected);
		assert.equal(f.value, "`/next.pdf`");
		const beforeInput = await f.event("beforeinput", { inputType: "deleteByCut" });
		assert.equal(beforeInput.defaultPrevented, true);
		assert.equal(f.value, "`/next.pdf`", "a trailing deleteByCut must not delete the neighboring chip");
	}
});

test("copying even a partial visual chip label copies its complete source", async () => {
	const f = await fixture("read `/deep/course/notes.pdf` now");
	const label = f.root.querySelector(`[${PATH_SOURCE_ATTRIBUTE}] [role=img] span`)!.firstChild!;
	f.selection.setBaseAndExtent(label, 1, label, 3);
	f.doc.dispatchEvent(new window.Event("selectionchange"));
	let copied = "";
	await f.event("copy", { clipboardData: { setData: (_type: string, value: string) => { copied = value; } } });
	assert.equal(copied, "`/deep/course/notes.pdf`");
});

test("composition keeps native DOM untouched, emits once, and suppresses consumer Enter", async () => {
	const f = await fixture("hello ");
	f.select(6);
	await f.event("compositionstart");
	f.root.replaceChildren(f.doc.createTextNode("hello 中"));
	f.select(7);
	await f.event("input", { isComposing: true });
	await f.event("keydown", { key: "Enter", keyCode: 229, isComposing: true });
	assert.equal(f.writes.length, 0);
	assert.equal(f.keys, 0);
	assert.equal(readPathInput(f.root), "hello 中");
	await f.event("compositionend");
	assert.deepEqual(f.writes, ["hello 中"]);
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "hello ");
});

test("Enter inserts a literal newline and range deletion spans text and complete chips", async () => {
	const f = await fixture("a `/one.pdf` b");
	f.select(f.value.length);
	await f.event("beforeinput", { inputType: "insertParagraph" });
	assert.equal(f.value, "a `/one.pdf` b\n");
	f.select(1, f.value.length - 1);
	await f.event("keydown", { key: "Delete" });
	assert.equal(f.value, "a\n");
	assert.equal(readPathInput(f.root), "a\n");
});

test("multiple trailing newlines preserve selection and survive native Backspace plus undo/redo", async () => {
	const f = await fixture("one\n\n");
	f.select(f.value.length, 1);
	assert.deepEqual(readPathSelection(f.root), { anchor: 5, focus: 1 });
	f.select(f.value.length);
	assert.equal(f.selection.focusNode, f.root);
	assert.equal(f.root.lastElementChild?.hasAttribute(PATH_CARET_ATTRIBUTE), true);
	// linkedom has no default Backspace action; model the native text deletion.
	await f.nativeText("one\n", "deleteContentBackward");
	assert.equal(f.value, "one\n");
	assert.equal(readPathInput(f.root), f.value);
	assert.equal(f.root.querySelectorAll(`[${PATH_CARET_ATTRIBUTE}]`).length, 1);
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "one\n\n");
	assert.deepEqual(readPathSelection(f.root), { anchor: 5, focus: 5 });
	assert.equal(f.root.querySelectorAll(`[${PATH_CARET_ATTRIBUTE}]`).length, 1);
	await f.event("keydown", { key: "z", metaKey: true, shiftKey: true });
	assert.equal(f.value, "one\n");
	assert.deepEqual(readPathSelection(f.root), { anchor: 4, focus: 4 });
	await f.external("");
	assert.equal(f.root.dataset.empty, "true");
	assert.equal(f.root.querySelector(`[${PATH_CARET_ATTRIBUTE}]`), null);
});

test("single-line mode never adds a trailing newline caret placeholder", async () => {
	const f = await fixture("one\n\n", true);
	assert.equal(readPathInput(f.root), "one");
	assert.equal(f.root.querySelector(`[${PATH_CARET_ATTRIBUTE}]`), null);
});

test("paste during IME stays plaintext and is deferred until composition finishes", async () => {
	const f = await fixture("");
	f.select(0);
	await f.event("compositionstart");
	f.root.replaceChildren(f.doc.createTextNode("中"));
	f.select(1);
	await f.event("input", { isComposing: true });
	assert.equal(f.root.dataset.empty, "false", "placeholder hides without normalizing the composing DOM");
	const paste = await f.event("paste", { clipboardData: { getData: () => "<b>plain</b>" } });
	assert.equal(paste.defaultPrevented, true);
	assert.equal(readPathInput(f.root), "中");
	assert.equal(f.writes.length, 0);
	await f.event("compositionend");
	assert.equal(f.value, "中<b>plain</b>");
	assert.equal(f.root.querySelector("b"), null);
});

test("single-line normalization strips only CR/LF and remaps directional UTF-16 selections", () => {
	const source = "🙂\r\n中\t x\ny\r";
	assert.equal(normalizePathInputValue(source, false), source);
	assert.equal(normalizePathInputValue(source, true), "🙂中\t xy");
	assert.deepEqual(normalizePathEdit({ value: source, selection: { anchor: source.length, focus: 4 } }, true), {
		value: "🙂中\t xy", selection: { anchor: 7, focus: 2 },
	});
});

test("single-line mode exposes native input accessibility and horizontal, nonwrapping layout", () => {
	const html = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} singleLine className="h-8" />);
	assert.match(html, /aria-multiline="false"/);
	assert.match(html, /whitespace-pre /);
	assert.match(html, /overflow-x-auto/);
	assert.match(html, /overflow-y-hidden/);
	assert.doesNotMatch(html, /whitespace-pre-wrap/);
	assert.match(html, /h-8/);
});

test("single-line initial/external assignment sanitizes silently; native edits and paste emit sanitized values", async () => {
	const f = await fixture("one\r\ntwo\n", true);
	assert.equal(readPathInput(f.root), "onetwo");
	assert.deepEqual(f.writes, []);
	await f.external("hello\r\nworld");
	assert.equal(readPathInput(f.root), "helloworld");
	assert.deepEqual(f.writes, []);
	f.select(10);
	await f.nativeText("ab\r\nc");
	assert.equal(f.value, "abc");
	assert.equal(readPathInput(f.root), "abc");
	assert.equal(pathInputOffset(f.root, f.selection.focusNode!, f.selection.focusOffset), 3);
	await f.event("paste", { clipboardData: { getData: () => "x\r\n y\n" } });
	assert.equal(f.value, "abcx y");
	assert.deepEqual(f.writes, ["abc", "abcx y"]);
});

test("single-line Enter reaches its consumer but cannot insert a newline", async () => {
	const f = await fixture("answer", true);
	f.select(6);
	await f.event("keydown", { key: "Enter", shiftKey: true });
	assert.equal(f.keys, 1);
	const paragraph = await f.event("beforeinput", { inputType: "insertParagraph" });
	const lineBreak = await f.event("beforeinput", { inputType: "insertLineBreak" });
	assert.equal(paragraph.defaultPrevented, true);
	assert.equal(lineBreak.defaultPrevented, true);
	assert.equal(f.value, "answer");
	assert.deepEqual(f.writes, []);
	await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/course/notes.pdf"] });
	assert.equal(f.value, "answer `/course/notes.pdf`");
});

test("single-line IME sanitizes after completion, and queued external assignments do not synthesize changes", async () => {
	const f = await fixture("a", true);
	f.select(1);
	await f.event("compositionstart");
	f.root.replaceChildren(f.doc.createTextNode("a中\r\n文"));
	f.select(5);
	await f.event("input", { isComposing: true });
	assert.deepEqual(f.writes, []);
	await f.event("compositionend");
	assert.equal(f.value, "a中文");
	assert.equal(readPathInput(f.root), "a中文");
	await f.event("compositionstart");
	await f.external("external\r\nvalue");
	assert.equal(readPathInput(f.root), "a中文", "assignment waits for native composition to finish");
	await f.event("compositionend");
	assert.equal(readPathInput(f.root), "externalvalue");
	assert.deepEqual(f.writes, ["a中文"]);
});

import { act } from "react";
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

// linkedom lacks the selection, focus and observer APIs CodeMirror touches, and has no
// layout, so CodeMirror's measure pass (scheduled by requestAnimationFrame) never runs.
const dom = parseHTML("<!DOCTYPE html><html><body></body></html>");
const noSelection = () => ({ rangeCount: 0, anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, addRange() {}, removeAllRanges() {}, collapse() {}, extend() {}, getRangeAt: () => null });
Object.assign(dom.document, { getSelection: noSelection, hasFocus: () => false, compatMode: "CSS1Compat" });
Object.assign(dom.window, { getSelection: noSelection });
Object.assign(globalThis, {
	window: dom.window,
	Window: class {},
	document: dom.document,
	IS_REACT_ACT_ENVIRONMENT: true,
	MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
});

const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { undo } = await import("@codemirror/commands");
const { highlightingFor } = await import("@codemirror/language");
const { tags } = await import("@lezer/highlight");
const { NotesEditor } = await import("../components/notes-editor.tsx");
const { NotesController } = await import("../components/notes-state.tsx");

const puts: string[] = [];
let serverText = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
	if (init.method === "PUT") puts.push(String(init.body));
	return Response.json(init.method === "PUT" ? { ok: true } : { text: serverText });
}) as typeof fetch;
after(() => void (globalThis.fetch = realFetch));

const storage = { getItem: () => null, setItem() {} };
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await cleanup?.();
	cleanup = null;
	puts.length = 0;
});

async function mount(text: string) {
	const controller = new NotesController("c1", text, { saveDelayMs: 60_000, storage });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<NotesEditor controller={controller} />));
	const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
	view.dispatch({ selection: { anchor: text.length } });
	cleanup = async () => {
		await act(async () => root.unmount());
		controller.dispose();
		host.remove();
	};
	return { controller, view };
}

function press(view: InstanceType<typeof EditorView>, key: string, keyCode: number) {
	const e = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(e, { key, keyCode });
	view.contentDOM.dispatchEvent(e as unknown as Event);
}

describe("notes editor", () => {
	it("claims Esc so the window abort chain never sees it", async () => {
		const { view } = await mount("typing");
		let reached = 0;
		const onKey = () => void reached++;
		dom.window.addEventListener("keydown", onKey);
		press(view, "Escape", 27);
		press(view, "a", 65);
		dom.window.removeEventListener("keydown", onKey);
		assert.equal(reached, 1); // only "a"
	});
	it("Enter does not continue a quote, but still continues a list", async () => {
		for (const [doc, want] of [
			["> quoted", "> quoted\n"],
			["> quoted\nmy words", "> quoted\nmy words\n"],
			["- item", "- item\n- "],
		]) {
			const { view } = await mount(doc!);
			press(view, "Enter", 13);
			assert.equal(view.state.doc.toString(), want, doc);
			await cleanup!();
			cleanup = null;
		}
	});
	it("refresh puts the saved text in the editor without an undo step or a save", async () => {
		const { controller, view } = await mount("stale");
		serverText = "newer";
		await controller.refresh();
		assert.equal(view.state.doc.toString(), "newer");
		assert.equal(undo(view), false);
		assert.equal(await controller.flush(), true);
		assert.deepEqual(puts, []);
	});
	it("styles Markdown and keeps its marks visible", async () => {
		const { view } = await mount("**bold** text");
		const strong = highlightingFor(view.state, [tags.strong]);
		assert.ok(strong, "a style for bold");
		const span = [...view.contentDOM.querySelectorAll("span")].find((s) => s.textContent === "**bold**");
		assert.ok(span, "bold, marks included, sits in a styled span");
		assert.equal(span.className, strong);
		assert.equal(view.contentDOM.textContent, "**bold** text");
	});
});

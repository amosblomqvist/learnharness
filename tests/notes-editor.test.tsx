import { act } from "react";
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

// linkedom lacks the selection, focus and observer APIs CodeMirror touches, and has no
// layout, so CodeMirror's measure pass (scheduled by requestAnimationFrame) never runs.
const dom = parseHTML("<!DOCTYPE html><html><body></body></html>");
const noSelection = () => ({ rangeCount: 0, anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, addRange() {}, removeAllRanges() {}, collapse() {}, extend() {}, getRangeAt: () => null });
// What CodeMirror's hasFocus reads; `focus` below sets it.
let focused: Element | null = null;
Object.assign(dom.document, { getSelection: noSelection, hasFocus: () => focused !== null, compatMode: "CSS1Compat" });
Object.defineProperty(dom.document, "activeElement", { get: () => focused ?? dom.document.body });
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
	focused = null;
});

/** Focus or blur the editor: CodeMirror notices on its next update and sends the change a microtask later. */
async function focus(view: InstanceType<typeof EditorView>, on = true) {
	focused = on ? view.contentDOM : null;
	view.dispatch({});
	await Promise.resolve();
}

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
	it("rendered display math in a quote covers the line's marker, so no bare `>` row is left", async () => {
		const text = "> Then\n>\n> $$x = 1$$\n> One draw.\n";
		const { view } = await mount(text);
		const line = () => [...view.contentDOM.querySelectorAll(".cm-line")][2]!;
		assert.ok(line().querySelector(".lh-note-display-math > .katex-display"), "the formula renders in its inline-block wrapper");
		assert.ok(!line().textContent!.startsWith(">"), "no marker in front of the formula");
		assert.ok(line().classList.contains("lh-note-quote"), "still styled as a quote");
		await focus(view);
		view.dispatch({ selection: { anchor: text.indexOf("> $$") } });
		assert.equal(line().textContent, "> $$x = 1$$", "the caret on the marker shows the source");
	});
	it("draws a table, with math and bold in its cells, until the cursor enters it", async () => {
		const text = "| x | name |\n|---|---|\n| $\\epsilon$ | **eps** |\n| | blank first |\n\nafter";
		const { view } = await mount(text);
		const table = view.contentDOM.querySelector("table")!;
		assert.ok(table, "the table renders");
		const rows = [...table.querySelectorAll("tr")];
		assert.deepEqual([...rows[0]!.children].map((c) => c.textContent), ["x", "name"]);
		const [math, bold] = [...rows[1]!.children];
		assert.equal(math!.querySelector("annotation")?.textContent, "\\epsilon");
		assert.equal(bold!.querySelector("strong")?.textContent, "eps");
		assert.deepEqual([...rows[2]!.children].map((c) => c.textContent), ["", "blank first"], "an empty cell keeps its column");
		assert.ok(!view.contentDOM.textContent!.includes("|"), "no source pipes");
		await focus(view);
		view.dispatch({ selection: { anchor: text.indexOf("name") } });
		assert.equal(view.contentDOM.querySelector("table"), null);
		assert.ok(view.contentDOM.textContent!.includes("| x | name |"), "the cursor inside shows the source");
	});
	it("keeps a formula whole in a table cell, and draws a quoted table as a quote", async () => {
		const { view } = await mount("> | f |\n> |---|\n> | $a*b*c$ |\n\nafter");
		const table = view.contentDOM.querySelector("table")!;
		assert.equal(table.querySelector("annotation")?.textContent, "a*b*c", "the `*b*` is not emphasis");
		assert.ok(table.closest(".lh-note-quote"), "styled as a quote");
		assert.ok(!view.contentDOM.textContent!.includes(">"), "no quote markers left");
	});
	it("renders Markdown away from the cursor: marks hidden; headings, bullets, rules and code blocks drawn", async () => {
		const text = "# Title\n\n**bold**, *it*, `code`, ~~gone~~, [a link](http://x \"t\") and [plain]\n\n> quoted\n\n- item\n\n---\n\n```py\nlet a = 1\n```\n\nend";
		const { view } = await mount(text);
		const shown = view.contentDOM.textContent!;
		for (const mark of ["#", "**", "*it", "`", "~~", "](", "http://x", ">", "- item", "---"]) assert.ok(!shown.includes(mark), mark);
		assert.match(shown, /bold, it, code, gone, a link and \[plain\]/, "a bracket with no link keeps its brackets");
		const lines = [...view.contentDOM.querySelectorAll(".cm-line")];
		assert.ok(lines.find((l) => l.textContent === "Title")?.classList.contains("lh-note-h1"));
		const span = (text: string) => [...view.contentDOM.querySelectorAll("span")].find((s) => s.textContent === text)?.className;
		assert.equal(span("bold"), highlightingFor(view.state, [tags.strong]));
		assert.equal(span("gone"), highlightingFor(view.state, [tags.strikethrough]));
		assert.ok(lines.find((l) => l.textContent === "quoted")?.classList.contains("lh-note-quote"));
		assert.equal(lines.find((l) => l.textContent!.endsWith("item"))?.textContent, "• item");
		assert.ok(view.contentDOM.querySelector(".lh-note-hr"));
		assert.equal(view.contentDOM.querySelector(".lh-note-code")?.textContent, "let a = 1");
	});
	it("shows the source only at the cursor, and only while the notes have focus", async () => {
		const text = "# Title\n**bold** and `code`\n- item\n```\nx\n```";
		const { view } = await mount(text);
		const shown = () => view.contentDOM.textContent!;
		view.dispatch({ selection: { anchor: text.indexOf("bold") } });
		assert.ok(!shown().includes("**"), "unfocused, the cursor reveals nothing");
		await focus(view);
		assert.ok(shown().includes("**bold**"), "the bold under the cursor");
		assert.ok(!shown().includes("`code`") && !shown().includes("# Title"), "not its neighbor, nor other lines");
		view.dispatch({ selection: { anchor: 3 } });
		assert.ok(shown().includes("# Title"), "a heading's line");
		view.dispatch({ selection: { anchor: text.indexOf("item") } });
		assert.ok(shown().includes("• item"), "a bullet stays drawn after it");
		view.dispatch({ selection: { anchor: text.indexOf("- item") } });
		assert.ok(shown().includes("- item"), "and shows at the mark");
		view.dispatch({ selection: { anchor: text.indexOf("x\n```") } });
		assert.equal(view.contentDOM.querySelector(".lh-note-code"), null);
		assert.ok(shown().includes("```"), "a code block's fences, inside it");
		await focus(view, false);
		assert.ok(view.contentDOM.querySelector(".lh-note-code"), "away from the notes, all of it renders");
	});
	it("draws a quoted code block as code in the quote", async () => {
		const { view } = await mount("> ```py\n> x = 1\n>\n> y\n> ```\n\nafter");
		const code = view.contentDOM.querySelector(".lh-note-code")!;
		assert.equal(code.textContent, "x = 1\n\ny");
		assert.ok(code.closest(".lh-note-quote"), "styled as a quote");
		assert.ok(!view.contentDOM.textContent!.includes(">"), "no quote markers left");
		await focus(view);
		view.dispatch({ selection: { anchor: 12 } });
		const lines = [...view.contentDOM.querySelectorAll(".cm-line")].slice(0, 5).map((l) => l.textContent);
		assert.deepEqual(lines, ["> ```py", "> x = 1", ">", "> y", "> ```"], "the cursor in it shows all of its source");
	});
	it("draws its own selection, so leaving it with the cursor at a soft wrap can't pull focus back", async () => {
		const { view } = await mount("text");
		assert.ok(view.dom.querySelector(".cm-selectionLayer"), "drawSelection's layer is present");
	});
	it("draws a callout as the chat's box, without its marker line", async () => {
		const text = "> [!IMPORTANT]\n> **Key** idea\n> second line\n\n> [!nope]\n> plain quote\n\n> [!NOTE]\n\nafter";
		const { view } = await mount(text);
		const line = (start: string) => [...view.contentDOM.querySelectorAll(".cm-line")].find((l) => l.textContent!.startsWith(start));
		assert.ok(!view.contentDOM.textContent!.includes("[!IMPORTANT]"), "the marker line is hidden");
		assert.deepEqual([...line("Key idea")!.classList].filter((c) => c.startsWith("lh-note-")), ["lh-note-callout", "lh-note-callout-top"], "the box's top, with no quote bar");
		assert.deepEqual([...line("second line")!.classList].filter((c) => c.startsWith("lh-note-")), ["lh-note-callout", "lh-note-callout-bottom"]);
		assert.ok(line("[!nope]")?.classList.contains("lh-note-quote"), "an unknown marker is a plain quote");
		assert.ok(line("[!NOTE]"), "a marker with nothing after it stays");
		await focus(view);
		view.dispatch({ selection: { anchor: 3 } });
		assert.ok(line("> [!IMPORTANT]")?.classList.contains("lh-note-callout-top"), "the cursor on it shows the marker line, in the box");
	});
	it("keeps the quote's bar outside a quoted callout's box", async () => {
		const { view } = await mount("> > [!tip]\n> > text\n\nafter");
		const text = [...view.contentDOM.querySelectorAll(".cm-line")].find((l) => l.textContent === "text")!;
		for (const c of ["lh-note-quote", "lh-note-callout", "lh-note-callout-top", "lh-note-callout-bottom"]) assert.ok(text.classList.contains(c), c);
	});
	it("draws a mermaid block as a chart, showing its code until the chart is drawn", async () => {
		const text = "```mermaid\ngraph TD; A-->B\n```\n\nafter";
		const { view } = await mount(text);
		const block = view.contentDOM.querySelector(".lh-note-mermaid-block");
		assert.ok(block, "a chart block, not a code block");
		assert.equal(view.contentDOM.querySelector(".lh-note-code-block"), null);
		assert.equal(block.textContent, "graph TD; A-->B");
		await focus(view);
		view.dispatch({ selection: { anchor: 5 } });
		assert.ok(view.contentDOM.textContent!.includes("```mermaid"), "the cursor in it shows its source");
	});
	it("styles Markdown, with the marks the cursor shows", async () => {
		const { view } = await mount("**bold** text");
		await focus(view);
		view.dispatch({ selection: { anchor: 3 } });
		const strong = highlightingFor(view.state, [tags.strong]);
		assert.ok(strong, "a style for bold");
		const span = [...view.contentDOM.querySelectorAll("span")].find((s) => s.textContent === "**bold**");
		assert.ok(span, "bold, marks included, sits in a styled span");
		assert.equal(span.className, strong);
		assert.equal(view.contentDOM.textContent, "**bold** text");
	});
});

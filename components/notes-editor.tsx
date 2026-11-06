"use client";

import { useEffect, useRef } from "react";
import katex from "katex";
import { defaultKeymap, history, historyKeymap, simplifySelection } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { Annotation, EditorState, Prec, StateEffect, StateField, Transaction, type Line, type Range, type StateCommand } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { mathRanges, quoteLineStarts, type MathRange } from "@/components/notes-markdown";
import type { NotesController, NotesEditorPort } from "@/components/notes-state";

class MathWidget extends WidgetType {
	constructor(
		readonly tex: string,
		readonly display: boolean,
	) {
		super();
	}

	eq(other: MathWidget): boolean {
		return other.tex === this.tex && other.display === this.display;
	}

	toDOM(): HTMLElement {
		const el = document.createElement("span");
		if (this.display) el.className = "lh-note-display-math";
		katex.render(this.tex, el, { displayMode: this.display, throwOnError: false });
		return el;
	}

	// Let clicks on rendered math place the caret, which reveals the source.
	ignoreEvent(): boolean {
		return false;
	}
}

/** A table cell's content: text, a formula, or a styled run. */
type Inline = string | { tex: string } | { tag: string; children: Inline[] };

const INLINE_TAGS: Record<string, string> = { StrongEmphasis: "strong", Emphasis: "em", InlineCode: "code", Strikethrough: "s" };
const INLINE_MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);

function cellContent(state: EditorState, cell: SyntaxNode, math: MathRange[]): Inline[] {
	const text = (out: Inline[], from: number, to: number) => {
		for (const m of math) {
			if (m.from < from || m.to > to) continue;
			if (m.from > from) out.push(state.sliceDoc(from, m.from));
			out.push({ tex: m.tex });
			from = m.to;
		}
		if (to > from) out.push(state.sliceDoc(from, to));
	};
	const fill = (node: SyntaxNode, from: number, to: number): Inline[] => {
		const out: Inline[] = [];
		let pos = from;
		for (let c = node.firstChild; c; c = c.nextSibling) {
			const { from: start, to: end, name } = c;
			// Markdown parses `$a*b*c$` as emphasis; the text pass keeps a formula whole.
			if (math.some((m) => m.from < end && m.to > start && (m.from < start || m.to > end))) continue;
			const tag = INLINE_TAGS[name];
			if (!tag && !INLINE_MARKS.has(name) && name !== "Escape") continue;
			text(out, pos, start);
			if (tag) out.push({ tag, children: fill(c, start, end) });
			else if (name === "Escape") out.push(state.sliceDoc(start + 1, end));
			pos = end;
		}
		text(out, pos, to);
		return out;
	};
	return fill(cell, cell.from, cell.to);
}

/** A table row's cells; Markdown has no node for an empty cell, so the `|`s mark the columns. */
function rowCells(state: EditorState, row: SyntaxNode, math: MathRange[]): Inline[][] {
	const cells: Inline[][] = [];
	let cell: Inline[] | null = null;
	for (let c = row.firstChild; c; c = c.nextSibling) {
		if (c.name === "TableCell") cell = cellContent(state, c, math);
		else if (c.name === "TableDelimiter" && (c.prevSibling || cell)) {
			cells.push(cell ?? []);
			cell = null;
		}
	}
	if (cell) cells.push(cell);
	return cells;
}

function inlineDOM(parent: HTMLElement, content: Inline[]) {
	for (const item of content) {
		if (typeof item === "string") parent.append(item);
		else if ("tex" in item) katex.render(item.tex, parent.appendChild(document.createElement("span")), { throwOnError: false });
		else inlineDOM(parent.appendChild(document.createElement(item.tag)), item.children);
	}
}

class TableWidget extends WidgetType {
	private readonly key: string;

	constructor(
		readonly head: Inline[][],
		readonly body: Inline[][][],
		readonly quoted: boolean,
	) {
		super();
		this.key = JSON.stringify([head, body, quoted]);
	}

	eq(other: TableWidget): boolean {
		return other.key === this.key;
	}

	toDOM(): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = this.quoted ? "lh-note-table lh-note-quote" : "lh-note-table";
		const table = wrap.appendChild(document.createElement("table"));
		// The chat's table look, which globals.css keys to these attributes.
		table.setAttribute("data-streamdown", "table");
		const section = (tag: "thead" | "tbody", rows: Inline[][][], cellTag: "th" | "td") => {
			const el = table.appendChild(document.createElement(tag));
			el.setAttribute("data-streamdown", tag === "thead" ? "table-header" : "table-body");
			for (const row of rows) {
				const tr = el.appendChild(document.createElement("tr"));
				tr.setAttribute("data-streamdown", "table-row");
				for (const cell of row) inlineDOM(tr.appendChild(document.createElement(cellTag)), cell);
			}
		};
		section("thead", [this.head], "th");
		if (this.body.length) section("tbody", this.body, "td");
		return wrap;
	}

	// Let clicks place the caret, which reveals the source.
	ignoreEvent(): boolean {
		return false;
	}
}

function tableWidget(state: EditorState, table: SyntaxNode, math: MathRange[]): TableWidget {
	let head: Inline[][] = [];
	const body: Inline[][][] = [];
	for (let c = table.firstChild; c; c = c.nextSibling) {
		if (c.name === "TableHeader") head = rowCells(state, c, math);
		else if (c.name === "TableRow") body.push(rowCells(state, c, math));
	}
	// As in GFM, the header sets the columns: short rows get empty cells, extra ones drop.
	const rows = body.map((row) => head.map((_, i) => row[i] ?? []));
	return new TableWidget(head, rows, inBlockquote(table));
}

function inBlockquote(node: SyntaxNode): boolean {
	for (let p = node.parent; p; p = p.parent) if (p.name === "Blockquote") return true;
	return false;
}

/** Mermaid charts by source: the svg, or null if it can't be drawn. */
const charts = new Map<string, string | null>();
/** Charts being drawn, with the editors to redraw when each is done. */
const drawing = new Map<string, Set<EditorView>>();
const chartDrawn = StateEffect.define<null>();

/** Draws a chart with the chat's renderer, then redraws the notes, which measures its new height. */
function drawChart(view: EditorView, chart: string) {
	if (charts.has(chart)) return;
	const views = drawing.get(chart);
	if (views) return void views.add(view);
	drawing.set(chart, new Set([view]));
	// Loaded on first use, as mermaid is large. A chart that can't be drawn keeps showing its code.
	import("@/components/mermaid-render")
		.then(({ renderMermaid }) => renderMermaid(chart))
		.then(
			(svg) => {
				charts.set(chart, svg);
				for (const v of drawing.get(chart)!) v.dispatch({ effects: chartDrawn.of(null) });
			},
			() => void charts.set(chart, null),
		)
		.finally(() => drawing.delete(chart));
}

/** A code block, a mermaid chart or a rule, drawn; in a quote it keeps the quote's bar. */
class BlockWidget extends WidgetType {
	readonly svg: string | null;

	constructor(
		readonly kind: "code" | "mermaid" | "hr",
		readonly text: string,
		readonly quoted: boolean,
	) {
		super();
		this.svg = kind === "mermaid" ? (charts.get(text) ?? null) : null;
	}

	eq(other: BlockWidget): boolean {
		return other.kind === this.kind && other.text === this.text && other.quoted === this.quoted && other.svg === this.svg;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = this.quoted ? `lh-note-${this.kind}-block lh-note-quote` : `lh-note-${this.kind}-block`;
		if (this.svg) {
			const chart = wrap.appendChild(document.createElement("div"));
			chart.className = "lh-note-mermaid";
			chart.innerHTML = this.svg;
			return wrap;
		}
		const el = wrap.appendChild(document.createElement(this.kind === "hr" ? "div" : "pre"));
		el.className = this.kind === "hr" ? "lh-note-hr" : "lh-note-code";
		el.textContent = this.text;
		if (this.kind === "mermaid") drawChart(view, this.text);
		return wrap;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

function codeKind(state: EditorState, code: SyntaxNode): "code" | "mermaid" {
	const info = code.getChild("CodeInfo");
	return info && state.sliceDoc(info.from, info.to).trim().toLowerCase() === "mermaid" ? "mermaid" : "code";
}

/** A fenced block's code, without the quote markers its lines carry in a quote. */
function codeText(state: EditorState, code: SyntaxNode): string {
	let text = "";
	for (let c = code.firstChild; c; c = c.nextSibling) if (c.name === "CodeText") text += state.sliceDoc(c.from, c.to);
	return text;
}

class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const el = document.createElement("span");
		el.textContent = "•";
		return el;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

const hiddenMark = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });

const quoteLine = Decoration.line({ class: "lh-note-quote" });
const fromServer = Annotation.define<boolean>();

function inQuote(state: EditorState, pos: number): boolean {
	if (quoteLineStarts(state.doc.lineAt(pos).text).length) return true;
	// A plain line right after a `>` line parses as part of the quote too.
	const node = syntaxTree(state).resolveInner(pos, -1);
	for (let n: typeof node | null = node; n; n = n.parent) if (n.name === "Blockquote") return true;
	return false;
}

// Quotes are the tutor's words, so Enter must not continue one (markdown()'s Enter would).
const newlineInQuote: StateCommand = ({ state, dispatch }) => {
	if (!inQuote(state, state.selection.main.from)) return false;
	dispatch(state.update(state.replaceSelection("\n"), { scrollIntoView: true, userEvent: "input" }));
	return true;
};

/** The chat's callout markers (md-blocks.tsx), alone on a quote's first line. */
const CALLOUT_MARKER = /^ ?\[!(?:note|tip|important|warning|caution)\][ \t]*$/i;

type Span = { from: number; to: number };
const overlaps = (a: Span, spans: Span[]) => spans.some((b) => a.from < b.to && a.to > b.from);

function buildDecorations(state: EditorState, focused: boolean): DecorationSet {
	const text = state.doc.toString();
	const sel = state.selection.ranges;
	// Away from the notes all of it renders; in them, the source shows where the cursor is.
	const active = (from: number, to: number) => focused && sel.some((r) => r.from <= to && r.to >= from);
	const lineActive = (pos: number) => {
		const line = state.doc.lineAt(pos);
		return active(line.from, line.to);
	};
	const math = mathRanges(text);
	const decos: Range<Decoration>[] = [];
	const blocks: Span[] = [];
	/** Blocks the cursor shows as source, `>` and all. */
	const sources: Span[] = [];
	const hidden: (Span & { deco: Decoration })[] = [];
	const hide = (from: number, to: number, deco = hiddenMark) => hidden.push({ from, to, deco });
	const callouts: { marker: Line; last: Line; nested: boolean }[] = [];
	syntaxTree(state).iterate({
		enter: (n) => {
			const node = n.node;
			const parent = node.parent;
			switch (n.name) {
				case "Table":
				case "FencedCode":
				case "HorizontalRule": {
					const from = state.doc.lineAt(n.from).from;
					const to = state.doc.lineAt(n.to).to;
					if (active(from, to)) {
						sources.push({ from, to });
						return false;
					}
					const widget =
						n.name === "Table" ? tableWidget(state, node, math) : n.name === "FencedCode" ? new BlockWidget(codeKind(state, node), codeText(state, node), inBlockquote(node)) : new BlockWidget("hr", "", inBlockquote(node));
					blocks.push({ from, to });
					decos.push(Decoration.replace({ widget, block: true }).range(from, to));
					return false;
				}
				case "HeaderMark": {
					if (!parent?.name.startsWith("ATXHeading") || lineActive(n.from)) return;
					// With the space after an opening mark, or before a closing one.
					if (!node.prevSibling) hide(n.from, n.to + /^[ \t]*/.exec(text.slice(n.to))![0].length);
					else hide(n.from - /[ \t]*$/.exec(text.slice(0, n.from))![0].length, n.to);
					return;
				}
				case "QuoteMark":
					if (!lineActive(n.from)) hide(n.from, n.to + (text[n.to] === " " ? 1 : 0));
					return;
				case "ListMark":
					if (parent?.parent?.name === "BulletList" && !active(n.from, n.to)) hide(n.from, n.to, bullet);
					return;
				case "EmphasisMark":
				case "StrikethroughMark":
				case "CodeMark":
					if (parent && !active(parent.from, parent.to)) hide(n.from, n.to);
					return;
				case "Link": {
					// Only a link with its address inline: `[text]` alone may be just brackets.
					const close = node.getChildren("LinkMark")[1];
					if (close && node.getChild("URL") && !active(n.from, n.to)) {
						hide(n.from, n.from + 1);
						hide(close.from, n.to);
					}
					return;
				}
				case "Autolink":
					if (!active(n.from, n.to)) for (const mark of node.getChildren("LinkMark")) hide(mark.from, mark.to);
					return;
				case "Escape":
					if (!active(n.from, n.to)) hide(n.from, n.from + 1);
					return;
				case "Blockquote": {
					const marker = state.doc.lineAt(n.from);
					if (CALLOUT_MARKER.test(text.slice(node.firstChild!.to, marker.to))) callouts.push({ marker, last: state.doc.lineAt(n.to), nested: inBlockquote(node) });
					return;
				}
			}
			const heading = /^ATXHeading(\d)$/.exec(n.name);
			if (heading) decos.push(Decoration.line({ class: `lh-note-h${heading[1]}` }).range(state.doc.lineAt(n.from).from));
		},
	});
	const inBlock = (pos: number) => blocks.some((b) => b.from <= pos && pos <= b.to);
	// Callouts, boxed as in the chat. The marker line hides, unless the cursor is on it or nothing follows it.
	const ownBar = new Set<number>();
	for (const { marker, last, nested } of callouts) {
		let first = marker.number;
		if (last.number > first && !lineActive(marker.from)) {
			blocks.push({ from: marker.from, to: marker.to });
			decos.push(Decoration.replace({ block: true }).range(marker.from, marker.to));
			first++;
		}
		for (let i = first; i <= last.number; i++) {
			const line = state.doc.line(i);
			if (inBlock(line.from)) continue;
			if (!nested) ownBar.add(line.from);
			const edges = (i === first ? " lh-note-callout-top" : "") + (i === last.number ? " lh-note-callout-bottom" : "");
			decos.push(Decoration.line({ class: `lh-note-callout${edges}` }).range(line.from));
		}
	}
	for (const pos of quoteLineStarts(text)) if (!inBlock(pos) && !ownBar.has(pos)) decos.push(quoteLine.range(pos));
	// Formulas keep their source whole, drawn or not: Markdown parses `$a*b*c$` as emphasis.
	const formulas: Span[] = [];
	for (const { from: start, to, tex, display } of math) {
		let from = start;
		// Display math draws as a block, which would strand the line's quote marker on a row of its own.
		if (display) {
			const lineStart = state.doc.lineAt(from).from;
			if (/^ {0,3}(?:> ?)+$/.test(text.slice(lineStart, from))) from = lineStart;
		}
		if (inBlock(from)) continue;
		formulas.push({ from, to });
		if (active(from, to)) continue;
		decos.push(Decoration.replace({ widget: new MathWidget(tex, display) }).range(from, to));
	}
	const whole = [...blocks, ...sources, ...formulas];
	for (const h of hidden) if (!overlaps(h, whole)) decos.push(h.deco.range(h.from, h.to));
	return Decoration.set(decos, true);
}

const setFocused = StateEffect.define<boolean>();

// A StateField, not a view plugin: display math and tables replace across lines.
const notesDecorations = StateField.define<{ focused: boolean; decos: DecorationSet }>({
	create: (state) => ({ focused: false, decos: buildDecorations(state, false) }),
	// Long notes parse in the background; a table renders once the parse reaches it.
	update: (value, tr) => {
		const focused = tr.effects.reduce((on, e) => (e.is(setFocused) ? e.value : on), value.focused);
		const stale =
			focused !== value.focused || tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.effects.some((e) => e.is(chartDrawn));
		return stale ? { focused, decos: buildDecorations(tr.state, focused) } : value;
	},
	provide: (field) => [EditorView.decorations.from(field, (v) => v.decos), EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing))],
});

const CODE_BACKGROUND = "color-mix(in oklab, var(--background) 86%, black)";

const notesTheme = EditorView.theme({
	"&": { height: "100%", fontSize: "var(--lh-prose-size)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-prose)", lineHeight: "var(--lh-prose-leading)" },
	// Shrink to the panel, so a wide formula scrolls by itself instead of widening every line.
	".cm-content": { padding: "0.75rem", minWidth: 0 },
	".cm-cursor": { borderLeftColor: "currentColor" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "color-mix(in oklab, Highlight 40%, transparent)" },
	".cm-selectionBackground": { background: "color-mix(in oklab, Highlight 20%, transparent)" },
	".cm-placeholder": { color: "var(--muted-foreground)" },
	// Inline-block, or the block formula leaves an empty text row above and below it.
	".lh-note-display-math": { display: "inline-block", width: "100%", verticalAlign: "top" },
	".katex-display": { margin: "0.25em 0" },
	// Block widgets space themselves with padding: CodeMirror can't measure margins, and an
	// unmeasured margin offsets every line below it from clicks and arrow keys.
	// The chat's table, sized to the panel: cells wrap, and only a table too wide for that scrolls.
	".lh-note-table": { overflowX: "auto", paddingTop: "0.25rem", paddingBottom: "0.25rem" },
	".lh-note-table table": { width: "auto" },
	".lh-note-table th, .lh-note-table td": { padding: "0.25rem 0.5rem", textAlign: "left", verticalAlign: "top" },
	".lh-note-table th": { fontWeight: "600" },
	// Headings at the chat's weight (notesHighlight), sized down for the panel.
	".lh-note-h1": { fontSize: "1.5em" },
	".lh-note-h2": { fontSize: "1.3em" },
	".lh-note-h3": { fontSize: "1.15em" },
	".lh-note-code-block": { paddingTop: "0.25rem", paddingBottom: "0.25rem" },
	// Mermaid sizes the chart to the panel, never past its natural size, so its text stays the notes' size.
	".lh-note-mermaid-block": { paddingTop: "0.5rem", paddingBottom: "0.5rem" },
	".lh-note-mermaid": { display: "flex", justifyContent: "center", fontStyle: "normal" },
	".lh-note-code": { margin: 0, padding: "0.5rem 0.75rem", borderRadius: "6px", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: "0.9em", fontStyle: "normal", background: CODE_BACKGROUND },
	".lh-note-hr-block": { paddingTop: "0.75rem", paddingBottom: "0.75rem" },
	".lh-note-hr": { borderTop: "1px solid var(--border)" },
	".lh-note-quote": {
		borderLeft: "3px solid var(--border)",
		paddingLeft: ".5rem",
		fontStyle: "italic",
		color: "var(--muted-foreground)",
	},
	// The chat's callout: a white outline around upright text, no label. Drawn on each line, so padding, not margin.
	".lh-note-callout": { position: "relative", paddingLeft: "1rem", paddingRight: "1rem", fontStyle: "normal", color: "var(--foreground)" },
	".lh-note-callout::before": { content: '""', position: "absolute", top: 0, bottom: 0, left: 0, right: 0, borderLeft: "1px solid white", borderRight: "1px solid white", pointerEvents: "none" },
	".lh-note-callout-top": { paddingTop: "0.75rem" },
	".lh-note-callout-top::before": { borderTop: "1px solid white" },
	".lh-note-callout-bottom": { paddingBottom: "0.75rem" },
	".lh-note-callout-bottom::before": { borderBottom: "1px solid white" },
	// In a quote, the quote's bar stays outside the box.
	".lh-note-quote.lh-note-callout": { paddingLeft: "1.5rem", fontStyle: "normal", color: "var(--foreground)" },
	".lh-note-quote.lh-note-callout::before": { left: "0.5rem" },
});

// Markdown styling, for the rendered text and the source the cursor shows.
const notesHighlight = HighlightStyle.define([
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{ tag: tags.heading, fontWeight: "var(--lh-heading-weight, 900)" },
	{ tag: tags.monospace, fontFamily: "var(--font-mono)", background: CODE_BACKGROUND, borderRadius: "3px" },
	{ tag: tags.link, textDecoration: "underline" },
]);

export function NotesEditor({ controller }: { controller: NotesController }) {
	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const view = new EditorView({
			parent: hostRef.current!,
			state: EditorState.create({
				doc: controller.text(),
				extensions: [
					history(),
					Prec.highest(keymap.of([{ key: "Enter", run: newlineInQuote }])),
					// Claim Esc so the window chain doesn't read it as abort-turn.
					keymap.of([{ key: "Escape", run: simplifySelection, preventDefault: true, stopPropagation: true }, ...defaultKeymap, ...historyKeymap]),
					// GFM, for tables.
					markdown({ base: markdownLanguage }),
					syntaxHighlighting(notesHighlight),
					EditorView.lineWrapping,
					// With the native selection and line wrapping, CodeMirror moves the page's selection back into
					// the editor after it loses focus with the cursor at a soft wrap, losing a selection in the lesson.
					drawSelection(),
					placeholder("Jot down keywords, formulas, quotes…"),
					EditorView.updateListener.of((u) => {
						if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromServer))) controller.onEdit(u.state.doc.toString());
					}),
					notesDecorations,
					notesTheme,
				],
			}),
		});
		const port: NotesEditorPort = {
			reset: (text) =>
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: text },
					annotations: [Transaction.addToHistory.of(false), fromServer.of(true)],
				}),
		};
		controller.attach(port);
		return () => {
			controller.attach(null);
			view.destroy();
		};
	}, [controller]);

	return <div ref={hostRef} className="h-full" />;
}

"use client";

import { useEffect, useRef, useState } from "react";
import katex from "katex";
import { defaultKeymap, history, historyKeymap, simplifySelection } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { Annotation, EditorState, Prec, StateField, Transaction, type Range, type StateCommand } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { appendBlockText } from "@/src/core";
import { mathRanges, quoteLineStarts } from "@/components/notes-markdown";
import type { NotesController, NotesEditorPort } from "@/components/notes-state";
import { useSideChatStore } from "@/components/side-chat-state";

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

function buildDecorations(state: EditorState): DecorationSet {
	const text = state.doc.toString();
	const sel = state.selection.ranges;
	const decos: Range<Decoration>[] = quoteLineStarts(text).map((pos) => quoteLine.range(pos));
	for (const { from: start, to, tex, display } of mathRanges(text)) {
		let from = start;
		// Display math draws as a block, which would strand the line's quote marker on a row of its own.
		if (display) {
			const lineStart = state.doc.lineAt(from).from;
			if (/^ {0,3}(?:> ?)+$/.test(text.slice(lineStart, from))) from = lineStart;
		}
		if (sel.some((r) => r.from <= to && r.to >= from)) continue;
		decos.push(Decoration.replace({ widget: new MathWidget(tex, display) }).range(from, to));
	}
	return Decoration.set(decos, true);
}

// A StateField, not a view plugin: display math replacements can span lines.
const notesDecorations = StateField.define<DecorationSet>({
	create: buildDecorations,
	update: (decos, tr) => (tr.docChanged || tr.selection ? buildDecorations(tr.state) : decos),
	provide: (field) => EditorView.decorations.from(field),
});

const notesTheme = EditorView.theme({
	"&": { height: "100%", fontSize: "var(--lh-prose-size)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-prose)", lineHeight: "var(--lh-prose-leading)" },
	// Shrink to the panel, so a wide formula scrolls by itself instead of widening every line.
	".cm-content": { padding: "0.75rem", caretColor: "currentColor", minWidth: 0 },
	".cm-placeholder": { color: "var(--muted-foreground)" },
	// Inline-block, or the block formula leaves an empty text row above and below it.
	".lh-note-display-math": { display: "inline-block", width: "100%", verticalAlign: "top" },
	".katex-display": { margin: "0.25em 0" },
	".lh-note-quote": {
		borderLeft: "3px solid var(--border)",
		paddingLeft: ".5rem",
		fontStyle: "italic",
		color: "var(--muted-foreground)",
	},
});

// Markdown styling; the marks (`**`, `#`, backticks) stay visible.
const notesHighlight = HighlightStyle.define([
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.heading, fontWeight: "bold", fontSize: "1.1em" },
	{ tag: tags.monospace, fontFamily: "var(--font-mono)", background: "color-mix(in oklab, var(--background) 86%, black)", borderRadius: "3px" },
	{ tag: tags.link, textDecoration: "underline" },
]);

/** The selection Review would send, and where its button sits in the panel. */
interface ReviewTarget {
	from: number;
	text: string;
	top: number;
	left: number;
}

const REVIEW_BOX_WIDTH = 224;

export function NotesEditor({ controller }: { controller: NotesController }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const sideStore = useSideChatStore();
	const [target, setTarget] = useState<ReviewTarget | null>(null);
	const [noProse, setNoProse] = useState(false);

	useEffect(() => {
		// Reads the selection at measure time, so a stale request never revives the button.
		const place = (view: EditorView) =>
			view.requestMeasure({
				key: "lh-notes-review",
				read: () => {
					const { from, to } = view.state.selection.main;
					const text = view.state.sliceDoc(from, to);
					if (!text.trim()) return null;
					const end = view.coordsAtPos(to);
					const box = hostRef.current?.getBoundingClientRect();
					if (!end || !box || end.bottom < box.top || end.bottom > box.bottom) return null;
					const left = Math.max(8, Math.min(end.left - box.left, box.width - REVIEW_BOX_WIDTH - 8));
					return { from, text, top: end.bottom - box.top + 4, left };
				},
				write: (next) => setTarget(next),
			});
		const view = new EditorView({
			parent: hostRef.current!,
			state: EditorState.create({
				doc: controller.text(),
				extensions: [
					history(),
					Prec.highest(keymap.of([{ key: "Enter", run: newlineInQuote }])),
					// Claim Esc so the window chain doesn't read it as abort-turn.
					keymap.of([{ key: "Escape", run: simplifySelection, preventDefault: true, stopPropagation: true }, ...defaultKeymap, ...historyKeymap]),
					markdown(),
					syntaxHighlighting(notesHighlight),
					EditorView.lineWrapping,
					placeholder("Jot down keywords, formulas, quotes…"),
					EditorView.updateListener.of((u) => {
						if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromServer))) controller.onEdit(u.state.doc.toString());
						if (u.selectionSet || u.docChanged) setNoProse(false);
						if (u.selectionSet || u.docChanged || u.geometryChanged) place(u.view);
					}),
					EditorView.domEventHandlers({ scroll: (_e, v) => place(v) }),
					notesDecorations,
					notesTheme,
				],
			}),
		});
		const port: NotesEditorPort = {
			replace: (from, to, insert) => view.dispatch({ changes: { from, to, insert } }),
			append: (block) => {
				const doc = view.state.doc.toString();
				const next = appendBlockText(doc, block);
				const from = doc.trimEnd().length;
				view.dispatch({
					changes: { from, to: doc.length, insert: next.slice(from) },
					effects: EditorView.scrollIntoView(next.length),
				});
			},
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

	const review = async () => {
		if (!target) return;
		await controller.flush();
		const anchor = sideStore?.lastProseAnchor() ?? null;
		if (!sideStore || !anchor) return setNoProse(true);
		void sideStore.openReview(anchor, { highlight: target.text, from: target.from });
		setTarget(null);
	};

	return (
		<>
			<div ref={hostRef} className="h-full" />
			{target && (
				<div style={{ top: target.top, left: target.left }} className="absolute z-20 flex flex-col items-start gap-1">
					<button
						type="button"
						data-testid="notes-review"
						// Keep the editor's selection and focus through the press.
						onPointerDown={(e) => e.preventDefault()}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => void review()}
						className="flex h-7 items-center rounded-md border bg-popover px-2.5 font-ui text-xs font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent"
					>
						Review
					</button>
					{noProse && (
						<p role="status" style={{ width: REVIEW_BOX_WIDTH }} className="rounded-md border bg-popover px-2 py-1 font-ui text-xs text-muted-foreground shadow-md">
							Review works once the tutor has written something.
						</p>
					)}
				</div>
			)}
		</>
	);
}

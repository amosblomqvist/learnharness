import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { ltrPhrases, proseDirection } from "@/src/core";

/**
 * CONTENT DIRECTION FOR PLAIN TEXT: the same rule the markdown renderer
 * applies to prose, for the surfaces that show text as typed (learner
 * messages, titles, quotes, activity lines). The element takes its
 * direction from its own letters (src/core/bidi.ts; a URL reads as
 * left-to-right whatever its path holds) and, when that is right-to-left,
 * isolates every left-to-right phrase (`C++`, `f(x).`, `(derivative)`, a
 * URL) so punctuation stays attached to the phrase it belongs to. Text is
 * taken literally: `$` and backticks are characters. Text without letters
 * sets no `dir` and inherits the page direction.
 */

/** One piece of a block's inline content. */
export interface InlineChunk {
	/** The text it adds to the block's run scan (see `LITERAL_TEXT`, `BREAK_TEXT`). */
	text: string;
	/** An inline element, code or math, placed whole: `node` inside a phrase,
	 *  `own()` (the element handled as a context of its own) when no phrase holds
	 *  it. `isolated`: carries its own `dir="ltr"`, so alone it needs no wrapper.
	 *  Without it the chunk is text and is split at the phrase boundaries. */
	element?: { node: ReactNode; own: () => ReactNode; isolated?: boolean };
}

/** The chunks in order, each left-to-right phrase in one isolating span. */
export function isolateChunks(chunks: readonly InlineChunk[]): ReactNode[] {
	const phrases = ltrPhrases(chunks.map(({ text, element }) => ({ text, atomic: element !== undefined })));
	return phrases.flatMap(({ ltr, slices }, index): ReactNode[] => {
		const nodes = slices.map(({ part, from, to }) => {
			const { text, element } = chunks[part]!;
			return element === undefined ? text.slice(from, to) : ltr ? element.node : element.own();
		});
		if (!ltr || (slices.length === 1 && chunks[slices[0]!.part]!.element?.isolated)) return nodes;
		return [<span key={`ltr-${index}`} dir="ltr">{nodes}</span>];
	});
}

/** Plain text: a line is one text chunk. */
const textChunks = (line: string): InlineChunk[] => [{ text: line }];

/** A line's direction, read from its text chunks alone (an element such as a
 *  file-path chip has no direction of its own), and its content: a
 *  right-to-left line isolates its left-to-right phrases, elements included. */
function lineOf(chunks: readonly InlineChunk[]): { dir: "ltr" | "rtl" | undefined; content: ReactNode } {
	const dir = proseDirection(chunks.filter((chunk) => !chunk.element).map((chunk) => chunk.text).join(""));
	return { dir, content: dir === "rtl" ? isolateChunks(chunks) : chunks.map(({ text, element }) => element?.node ?? text) };
}

/** One line of a multi-line text: its own block, its own direction. An empty
 *  line keeps its height through a break, as a blank line does in `pre-wrap`. */
function BidiLine({ line, chunks }: { line: string; chunks: (line: string) => InlineChunk[] }) {
	const { dir, content } = lineOf(chunks(line));
	return <span className="block" dir={dir}>{line === "" ? <br /> : content}</span>;
}

type BidiTextProps<T extends ElementType> = {
	as?: T;
	text: string;
	/** The chunks of one line, for text that holds inline elements (a file-path
	 *  chip, see `filePathChunks`); each element is placed whole. Default: the
	 *  line is one text chunk. */
	chunks?: (line: string) => InlineChunk[];
	/** Keep the line breaks: one block per line, each with its own direction,
	 *  for text shown as typed (`whitespace-pre-wrap`). Without it the text is
	 *  one line under one direction, its whitespace collapsed to single spaces. */
	multiline?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "text" | "chunks" | "multiline" | "children" | "dir">;

/** Plain text under its own direction: `dir` on the element, the phrases
 *  isolated inside it. A line break collapses to a space, as it would in a
 *  one-line element (a title, an activity row), unless `multiline` keeps the
 *  lines: then each is a block of its own with its own direction, so an Arabic
 *  line and an English line in one message each read their own way; the
 *  element keeps its own classes, so `whitespace-pre-wrap` still applies. */
export function BidiText<T extends ElementType = "span">({ as, text: raw, chunks = textChunks, multiline = false, ...rest }: BidiTextProps<T>) {
	const Tag: ElementType = as ?? "span";
	// Persisted tool output reaches some call sites through casts, so a number
	// or a missing field renders the way React would render it instead of throwing.
	const text = typeof raw === "string" ? raw : String(raw ?? "");
	if (!multiline || !text.includes("\n")) {
		const { dir, content } = lineOf(chunks(multiline ? text : text.replace(/\s+/g, " ")));
		return <Tag {...rest} dir={dir}>{content}</Tag>;
	}
	const lines = text.split(/\r?\n/);
	// A trailing line break ends the last line; it does not open another one.
	if (lines.at(-1) === "") lines.pop();
	return <Tag {...rest}>{lines.map((line, index) => <BidiLine key={index} line={line} chunks={chunks} />)}</Tag>;
}

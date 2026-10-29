import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { letterDirection, ltrPhrases } from "@/src/core";

/**
 * CONTENT DIRECTION FOR PLAIN TEXT: the same rule the markdown renderer
 * applies to prose, for the surfaces that show text as typed (learner
 * messages, titles, quotes, activity lines). The element takes its
 * direction from its own letters (src/core/bidi.ts) and, when that is
 * right-to-left, isolates every left-to-right phrase (`C++`, `f(x).`,
 * `(derivative)`, a URL) so punctuation stays attached to the phrase it
 * belongs to. Text is taken literally: `$` and backticks are characters.
 * Text without letters sets no `dir` and inherits the page direction.
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

function lineContent(line: string, dir: "ltr" | "rtl" | undefined): ReactNode {
	return dir === "rtl" ? isolateChunks([{ text: line }]) : line;
}

/** One line of a multi-line text: its own block, its own direction. An empty
 *  line keeps its height through a break, as a blank line does in `pre-wrap`. */
function BidiLine({ line }: { line: string }) {
	const dir = letterDirection(line);
	return <span className="block" dir={dir}>{line === "" ? <br /> : lineContent(line, dir)}</span>;
}

type BidiTextProps<T extends ElementType> = { as?: T; text: string } & Omit<ComponentPropsWithoutRef<T>, "as" | "text" | "children" | "dir">;

/** Plain text under its own direction. Single-line text puts `dir` on the
 *  element. Multi-line text becomes one block per line inside the element, so
 *  an Arabic line and an English line in one message each read their own way;
 *  the element keeps its own classes, so `whitespace-pre-wrap` still applies. */
export function BidiText<T extends ElementType = "span">({ as, text: raw, ...rest }: BidiTextProps<T>) {
	const Tag: ElementType = as ?? "span";
	// Persisted tool output reaches some call sites through casts, so a number
	// or a missing field renders the way React would render it instead of throwing.
	const text = typeof raw === "string" ? raw : String(raw ?? "");
	if (!text.includes("\n")) {
		const dir = letterDirection(text);
		return <Tag {...rest} dir={dir}>{lineContent(text, dir)}</Tag>;
	}
	const lines = text.split(/\r?\n/);
	// A trailing line break ends the last line; it does not open another one.
	if (lines.at(-1) === "") lines.pop();
	return <Tag {...rest}>{lines.map((line, index) => <BidiLine key={index} line={line} />)}</Tag>;
}

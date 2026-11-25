import type { Element, ElementContent, Root, RootContent, Text } from "hast";

/**
 * Punctuation glue (owner, session-appearance-layout): on the session page
 * inline code and inline math never wrap, and each scrolls sideways when
 * wider than its column — an inline-block. Chrome may break a line on
 * either side of an inline-block even before a comma, so "f, the slope"
 * could start a line with ",". This step wraps each inline code/math span
 * together with the punctuation directly touching it (no space between) in
 * a `span.lh-nobreak`; globals.css stops wrapping inside it on the session
 * page only (elsewhere the span is inert).
 *
 * Runs in Streamdown's rehype list, after sanitize/harden and BEFORE
 * rehype-katex (the math plugin is appended after the list), so inline math
 * is still a `code.math-inline` element here; KaTeX renders it in place,
 * inside the wrapper. Inline = any `code` not inside `pre`.
 *
 * A link or emphasis holding only such a span counts as the span itself.
 * The group, not the span, is then what scrolls when too wide (globals.css).
 *
 * Only Unicode punctuation glues (",", ".", ")", "(", quotes, CJK "，。"):
 * letters never do, so text without spaces (CJK) keeps wrapping normally.
 * Punctuation between two spans ("$a$,$b$") joins them into one group.
 */
export const NOBREAK_CLASS = "lh-nobreak";

const LEADING = /^\p{P}+/u;
const TRAILING = /\p{P}+$/u;

/** Inline wrappers that may hold nothing but a span ("[`f`](url)",
 *  "**$x$**"): glued WHOLE, so no text ever moves into or out of a link. */
const WRAPPERS = new Set(["a", "strong", "em", "b", "i", "del", "s"]);

function isInlineCode(node: RootContent | ElementContent | undefined): node is Element {
	if (node?.type !== "element") return false;
	if (node.tagName === "code") return true;
	return WRAPPERS.has(node.tagName) && node.children.length === 1 && isInlineCode(node.children[0]);
}

function glueChildren(parent: Root | Element) {
	const children = parent.children as ElementContent[];
	const out: ElementContent[] = [];
	for (let i = 0; i < children.length; i++) {
		const node = children[i]!;
		if (!isInlineCode(node)) {
			out.push(node);
			continue;
		}
		const group: ElementContent[] = [];
		// Leading punctuation: the end of the text just before the span.
		const prev = out.at(-1);
		if (prev?.type === "text") {
			const lead = TRAILING.exec(prev.value)?.[0];
			if (lead) {
				prev.value = prev.value.slice(0, -lead.length);
				if (!prev.value) out.pop();
				group.push({ type: "text", value: lead } satisfies Text);
			}
		}
		group.push(node);
		// Trailing punctuation; a text node made only of punctuation that
		// sits between two spans joins the next span into the same group.
		while (i + 1 < children.length) {
			const next = children[i + 1]!;
			if (next.type !== "text") break;
			const tail = LEADING.exec(next.value)?.[0];
			if (!tail) break;
			if (tail.length === next.value.length && isInlineCode(children[i + 2])) {
				group.push(next, children[i + 2]!);
				i += 2;
				continue;
			}
			group.push({ type: "text", value: tail });
			next.value = next.value.slice(tail.length);
			if (!next.value) i++;
			break;
		}
		if (group.length === 1) out.push(node);
		else out.push({ type: "element", tagName: "span", properties: { className: [NOBREAK_CLASS] }, children: group });
	}
	parent.children = out;
}

function isGlue(node: Element): boolean {
	const cls = node.properties?.className;
	return Array.isArray(cls) && cls.includes(NOBREAK_CLASS);
}

function walk(node: Root | Element) {
	if (node.type === "element" && (node.tagName === "pre" || node.tagName === "code" || isGlue(node))) return;
	glueChildren(node);
	for (const child of node.children) if (child.type === "element") walk(child);
}

/** The rehype plugin (unified attacher). */
export function rehypeGluePunctuation() {
	return (tree: Root) => walk(tree);
}

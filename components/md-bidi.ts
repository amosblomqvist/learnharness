import type { Element, Root, RootContent } from "hast";
import { detectTextDirection } from "@/src/core";

/**
 * Automatic bidi directionality for rendered Markdown (rehype plugin).
 *
 * Runs AFTER sanitize/harden and rehypeGluePunctuation, and BEFORE
 * rehype-katex (transcript-math.ts):
 * - Stamps `dir="ltr"` on `code` and `pre` so inline code and math tokens
 *   are skipped by HTML's `dir="auto"` first-strong scan and render LTR.
 * - Stamps `dir="auto"` on leaf prose blocks (`p`, `h1`–`h6`, `th`, `td`,
 *   `dt`, `dd`, and tight `li`).
 * - Stamps resolved `dir="rtl"` on container blocks (`ul`, `ol`, `blockquote`,
 *   `table`, and loose `li`) when their prose (excluding `code`/`pre`) starts
 *   with a strong RTL character — per the HTML spec, `dir="auto"` on a parent
 *   skips descendants that carry their own `dir` attribute, which would
 *   otherwise leave RTL lists, blockquotes, and tables stuck in LTR.
 * - Leaves `span.lh-nobreak` without `dir` so glued punctuation inherits its
 *   enclosing paragraph's resolved direction while the math/code inside stays
 *   isolated LTR.
 */

const LEAF_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "th", "td", "dt", "dd"]);
const CONTAINER_BLOCKS = new Set(["ul", "ol", "blockquote", "table"]);
const LTR_ELEMENTS = new Set(["code", "pre"]);
const BLOCK_CHILDREN = new Set([...LEAF_BLOCKS, ...CONTAINER_BLOCKS, "li", "pre", "div"]);

function hasBlockChild(el: Element): boolean {
	return el.children.some((child) => child.type === "element" && BLOCK_CHILDREN.has(child.tagName));
}

function proseText(node: Root | RootContent): string {
	if (node.type === "text") return node.value;
	if (node.type === "element") {
		if (LTR_ELEMENTS.has(node.tagName)) return "";
		return node.children.map(proseText).join("");
	}
	if ("children" in node && Array.isArray(node.children)) {
		return node.children.map(proseText).join("");
	}
	return "";
}

function walk(node: Root | Element): void {
	if (node.type === "element") {
		const props = (node.properties ??= {});
		if (LTR_ELEMENTS.has(node.tagName)) {
			if (props.dir === undefined) props.dir = "ltr";
			return;
		}
		if (props.dir === undefined) {
			if (CONTAINER_BLOCKS.has(node.tagName)) {
				if (detectTextDirection(proseText(node)) === "rtl") props.dir = "rtl";
			} else if (node.tagName === "li") {
				if (hasBlockChild(node)) {
					if (detectTextDirection(proseText(node)) === "rtl") props.dir = "rtl";
				} else {
					props.dir = "auto";
				}
			} else if (LEAF_BLOCKS.has(node.tagName)) {
				props.dir = "auto";
			}
		}
	}
	for (const child of node.children) {
		if (child.type === "element") walk(child);
	}
}

/** Unified rehype attacher. */
export function rehypeBidi() {
	return (tree: Root) => walk(tree);
}

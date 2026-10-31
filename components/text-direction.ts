/**
 * Bidirectional text: Persian, Arabic and Hebrew read right-to-left inside
 * the left-to-right interface. Each block of learner or model text gets its
 * own base direction, so mixed Persian/English sentences keep their word
 * order and their punctuation on the correct side.
 */

const RTL_RANGES = "\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC";
/** Letter runs (≈ words) in right-to-left scripts. Digits and punctuation in
 *  those Unicode blocks do not vote. */
const RTL_WORD = new RegExp(`(?:(?=[\\p{L}\\p{M}])[${RTL_RANGES}])+`, "gu");
/** Letter runs of two or more in every other script. Single letters are
 *  mostly variables and units in this app (F = ma, 1 N = 1 kg·m/s²), so
 *  they do not outvote the Persian sentence around them. */
const LTR_WORD = new RegExp(`[^\\P{L}${RTL_RANGES}]{2,}`, "gu");

export type TextDirection = "ltr" | "rtl";

/** Base direction by word vote, not the first strong character that
 *  dir="auto" uses: Persian prose opening with an English term ("React یک
 *  کتابخانه است") must still read right-to-left. Undefined without letters. */
export function textDirection(text: string): TextDirection | undefined {
	const rtl = text.match(RTL_WORD)?.length ?? 0;
	const ltr = text.match(LTR_WORD)?.length ?? 0;
	if (rtl === 0) return ltr > 0 ? "ltr" : undefined;
	// Weighted 2:1 toward RTL: Persian technical prose borrows many English words.
	return rtl * 2 >= ltr ? "rtl" : "ltr";
}

/** `dir` for a label inside the left-to-right interface: set only for
 *  right-to-left text, so English labels render exactly as before. */
export function rtlDir(text: string | null | undefined): "rtl" | undefined {
	return text && textDirection(text) === "rtl" ? "rtl" : undefined;
}

type HastNode = {
	type: string;
	value?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

const BLOCKS = new Set(["p", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "th", "td", "dt", "dd"]);
/** Left-to-right islands: code, and math (remark-math emits it as <code>). */
const isCode = (node: HastNode) => node.tagName === "code" || node.tagName === "pre";

function proseText(node: HastNode): string {
	if (node.type === "text") return node.value ?? "";
	if (isCode(node)) return "";
	return node.children?.map(proseText).join("") ?? "";
}

function mark(node: HastNode, inherited: TextDirection): void {
	for (const child of node.children ?? []) {
		if (child.type !== "element" || isCode(child)) continue;
		let dir = inherited;
		if (child.tagName && BLOCKS.has(child.tagName)) {
			dir = textDirection(proseText(child)) ?? inherited;
			// Only where it changes: English-only markdown renders unchanged.
			if (dir !== inherited) child.properties = { ...child.properties, dir };
		}
		mark(child, dir);
	}
}

/** Rehype plugin: `dir` on every markdown block whose direction differs from
 *  its parent's — Persian paragraphs, and English cells in Persian tables. */
export function rehypeTextDirection() {
	return (tree: HastNode) => mark(tree, "ltr");
}

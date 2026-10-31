import { findSessionTextMatches } from "@/src/core";

/** Only marked session surfaces enter Find. Offscreen scroller content counts;
 * hidden/unmounted sections do not. Never walk embedded documents or drafts.
 * Do NOT exclude aria-hidden globally: KaTeX's VISIBLE HTML uses it too. */
const EXCLUDED = [
	"script", "style", "noscript", "textarea", "input", "select", "iframe", "canvas", '[contenteditable="true"]',
	"title", "defs", "metadata", "desc", ".katex-mathml", ".sr-only", "[hidden]",
	"[data-session-find-exclude]", "[data-lh-menu]", '[role="menu"]', '[role="dialog"]', '[role="tooltip"]',
].join(",");

interface TextPoint { node: Text; offset: number }
interface DisplayCharacter { start: TextPoint; end: TextPoint; collapsedSpace: boolean }
interface DisplayRun { text: string; characters: DisplayCharacter[] }

const BLOCK_DISPLAYS = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-cell", "table-caption", "flow-root"]);

function styleOf(element: Element): CSSStyleDeclaration | null {
	const view = element.ownerDocument.defaultView;
	// Test DOMs (linkedom) may ship no CSS OM — degrade to attribute-only
	// visibility checks; real browsers always implement it.
	return typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
}

function hidden(element: Element, style: CSSStyleDeclaration | null): boolean {
	return element.matches(EXCLUDED)
		|| !!style && (style.display === "none" || style.visibility === "hidden"
			|| style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden");
}

function displayedRoot(root: Element): boolean {
	for (let element: Element | null = root; element; element = element.parentElement) {
		if (hidden(element, styleOf(element))) return false;
	}
	return true;
}

/** Preserve a source-point map while collapsing ordinary HTML whitespace.
 * This lets a phrase span inline markup, without concatenating separate cards
 * or paragraphs. Preformatted code/user text keeps its literal whitespace. */
function displayRuns(root: Element): DisplayRun[] {
	const runs: DisplayRun[] = [];
	let text = "";
	let characters: DisplayCharacter[] = [];
	const flush = () => {
		if (characters.at(-1)?.collapsedSpace) {
			text = text.slice(0, -1);
			characters.pop();
		}
		if (text) runs.push({ text, characters });
		text = "";
		characters = [];
	};
	const append = (node: Text, whiteSpace: string) => {
		const collapse = !["pre", "pre-wrap", "break-spaces"].includes(whiteSpace);
		for (let i = 0; i < node.data.length; i++) {
			const char = node.data[i]!;
			if (whiteSpace === "pre-line" && /[\r\n]/.test(char)) { flush(); continue; }
			const space = collapse && /[\t\n\r\f ]/.test(char);
			if (space && !text) continue;
			if (space && characters.at(-1)?.collapsedSpace) {
				characters.at(-1)!.end = { node, offset: i + 1 };
				continue;
			}
			text += space ? " " : char;
			characters.push({ start: { node, offset: i }, end: { node, offset: i + 1 }, collapsedSpace: space });
		}
	};
	const visit = (element: Element) => {
		const style = styleOf(element);
		if (hidden(element, style)) return;
		if (element.tagName === "BR") { flush(); return; }
		const block = !!style && BLOCK_DISPLAYS.has(style.display);
		// Without a CSS OM (test DOMs), the HTML defaults stand: only pre-family
		// tags keep literal whitespace.
		const whiteSpace = style?.whiteSpace ?? (element.matches("pre, listing, plaintext") ? "pre" : "normal");
		if (block) flush();
		for (const child of element.childNodes) {
			if (child.nodeType === 3) append(child as Text, whiteSpace);
			else if (child.nodeType === 1) visit(child as Element);
		}
		if (block) flush();
	};
	visit(root);
	flush();
	return runs;
}

/** Minimal AbstractRange stand-in for DOMs without live Range support
 *  (linkedom in tests). Real browsers always take document.createRange. */
class StaticRangeLike {
	startContainer: Node = null as unknown as Node;
	startOffset = 0;
	endContainer: Node = null as unknown as Node;
	endOffset = 0;
	setStart(node: Node, offset: number): void { this.startContainer = node; this.startOffset = offset; }
	setEnd(node: Node, offset: number): void { this.endContainer = node; this.endOffset = offset; }
	get collapsed(): boolean { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
	toString(): string {
		const text = (node: Node) => (node.nodeType === 3 ? (node as Text).data : "");
		if (this.startContainer === this.endContainer) return text(this.startContainer).slice(this.startOffset, this.endOffset);
		// Cross-node: gather the document-order text between the boundaries.
		const texts: Text[] = [];
		const walk = (node: Node | null): void => {
			if (!node) return;
			if (node.nodeType === 3) texts.push(node as Text);
			for (const child of node.childNodes) walk(child);
		};
		walk(this.startContainer.ownerDocument);
		const start = texts.indexOf(this.startContainer as Text);
		const end = texts.indexOf(this.endContainer as Text);
		let out = text(this.startContainer).slice(this.startOffset);
		for (let i = start + 1; i < end && i >= 0; i++) out += texts[i]!.data;
		if (end >= 0) out += text(this.endContainer).slice(0, this.endOffset);
		return out;
	}
}

export function sessionFindRanges(scope: HTMLElement, query: string): Range[] {
	if (!query) return [];
	const roots = [
		...(scope.matches("[data-session-find-root]") ? [scope] : []),
		...scope.querySelectorAll<HTMLElement>("[data-session-find-root]"),
	];
	const ranges: Range[] = [];
	for (const root of roots) {
		// A nested marker must not double-count its text.
		if (roots.some((other) => other !== root && other.contains(root)) || !displayedRoot(root)) continue;
		for (const run of displayRuns(root)) {
			for (const match of findSessionTextMatches(run.text, query)) {
				const start = run.characters[match.start]!.start;
				const end = run.characters[match.end - 1]!.end;
				const native = scope.ownerDocument.createRange?.();
				const range = typeof native?.setStart === "function" ? native : (new StaticRangeLike() as unknown as Range);
				range.setStart(start.node, start.offset);
				range.setEnd(end.node, end.offset);
				ranges.push(range);
			}
		}
	}
	return ranges;
}

/** Frozen boundary identity, rather than a mutable live Range, survives text
 * appends while Find is open. A re-render may replace nodes; then the caller
 * clamps the old index without pulling the reader to a different passage. */
export interface SessionRangeIdentity {
	start: Node; startOffset: number; end: Node; endOffset: number;
}
export function sessionRangeIdentity(range: Range): SessionRangeIdentity {
	return { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset };
}
export function sameSessionRange(range: Range, identity: SessionRangeIdentity | null): boolean {
	return !!identity && range.startContainer === identity.start && range.startOffset === identity.startOffset
		&& range.endContainer === identity.end && range.endOffset === identity.endOffset;
}

import { parseFilePaths, quoteFilePath } from "@/src/core";

/** Tokens store their complete source, not their abbreviated visual label. */
export const PATH_SOURCE_ATTRIBUTE = "data-file-path-source";
/** Presentation-only line box for the caret after a final model newline. */
export const PATH_CARET_ATTRIBUTE = "data-file-path-caret";
export type TextSelection = { anchor: number; focus: number };
export type DOMPoint = { node: Node; offset: number };
type Segment = { text: string; start: DOMPoint; end: DOMPoint; node?: Text; token?: Element };

function childIndex(node: Node): number {
	return Array.prototype.indexOf.call(node.parentNode!.childNodes, node);
}

/** Browser editing can leave BR/block nodes; never use innerText (layout/whitespace dependent). */
function segments(root: HTMLElement): Segment[] {
	const result: Segment[] = [];
	function walk(node: Node) {
		if (node.nodeType === 3) {
			const text = node as Text;
			result.push({ text: text.data, start: { node, offset: 0 }, end: { node, offset: text.length }, node: text });
			return;
		}
		if (node.nodeType !== 1) return;
		const element = node as Element;
		if (element.hasAttribute(PATH_CARET_ATTRIBUTE)) return;
		const raw = element.getAttribute(PATH_SOURCE_ATTRIBUTE);
		if (raw !== null) {
			const index = childIndex(node);
			result.push({ text: raw, start: { node: node.parentNode!, offset: index }, end: { node: node.parentNode!, offset: index + 1 }, token: element });
			return;
		}
		if (element.tagName === "BR") {
			// Chromium's lone BR is an empty editor/paragraph placeholder.
			if (node.parentNode?.childNodes.length === 1) return;
			const index = childIndex(node);
			result.push({ text: "\n", start: { node: node.parentNode!, offset: index }, end: { node: node.parentNode!, offset: index + 1 } });
			return;
		}
		Array.from(node.childNodes).forEach((child, index) => {
			const block = child.nodeType === 1 && /^(DIV|P)$/.test((child as Element).tagName);
			const previous = node.childNodes[index - 1];
			const previousBlock = previous?.nodeType === 1 && /^(DIV|P)$/.test((previous as Element).tagName);
			if (index > 0 && (block || previousBlock)) {
				result.push({ text: "\n", start: { node, offset: index }, end: { node, offset: index } });
			}
			walk(child);
		});
	}
	walk(root);
	return result;
}

export function readPathInput(root: HTMLElement): string {
	return segments(root).map((part) => part.text).join("");
}

/** Map a logical UTF-16 offset to a DOM boundary, snapping a chip interior atomically. */
export function pathInputPoint(root: HTMLElement, offset: number): DOMPoint {
	const parts = segments(root);
	const trailing = root.lastChild;
	if (trailing?.nodeType === 1 && (trailing as Element).hasAttribute(PATH_CARET_ATTRIBUTE)
		&& offset >= parts.reduce((length, part) => length + part.text.length, 0)) {
		// A text-node endpoint after its final newline has no line box in Chromium.
		// The boundary immediately before this BR is on the visible final line.
		return { node: root, offset: childIndex(trailing) };
	}
	let remaining = Math.max(0, offset);
	for (const part of parts) {
		if (remaining <= part.text.length) {
			if (part.node) return { node: part.node, offset: remaining };
			return remaining <= part.text.length / 2 ? part.start : part.end;
		}
		remaining -= part.text.length;
	}
	return { node: root, offset: root.childNodes.length };
}

/** Works without Range: useful in DOM test environments as well as real Selection. */
export function pathInputOffset(root: HTMLElement, node: Node, offset: number): number | null {
	if (node !== root && !root.contains(node)) return null;
	let total = 0;
	for (const part of segments(root)) {
		if (part.node === node) return total + Math.min(Math.max(0, offset), part.text.length);
		if (part.token?.contains(node)) {
			// A mouse/programmatic selection can end inside a noneditable label.
			// Keep distinct interior endpoints so atomicPathRange expands copy/cut
			// to the complete source instead of leaking the abbreviated filename.
			let visualOffset = node.nodeType === 3 ? offset : Array.from(node.childNodes).slice(0, offset).reduce((length, child) => length + (child.textContent?.length ?? 0), 0);
			let cursor = node;
			while (cursor !== part.token) {
				let sibling = cursor.previousSibling;
				while (sibling) { visualOffset += sibling.textContent?.length ?? 0; sibling = sibling.previousSibling; }
				cursor = cursor.parentNode!;
			}
			const visualLength = part.token.textContent?.length ?? 0;
			return total + (visualLength ? Math.round(Math.min(visualLength, visualOffset) / visualLength * part.text.length) : 0);
		}
		if (part.start.node === node && part.start.offset >= offset) return total;
		if (part.end.node === node && part.end.offset <= offset) {
			total += part.text.length;
			continue;
		}
		// A boundary in an ancestor is before/after every descendant segment.
		let ancestor: Node = part.node ?? part.token ?? part.start.node;
		while (ancestor.parentNode && ancestor.parentNode !== node) ancestor = ancestor.parentNode;
		if (ancestor.parentNode === node && childIndex(ancestor) >= offset) return total;
		total += part.text.length;
	}
	return total;
}

/** Validate a browser beforeinput StaticRange before projecting its exact endpoints. */
export function pathInputStaticRange(root: HTMLElement, range: Pick<StaticRange, "startContainer" | "startOffset" | "endContainer" | "endOffset">): TextSelection | null {
	function valid(node: Node, offset: number) {
		return (node === root || root.contains(node)) && Number.isInteger(offset) && offset >= 0
			&& offset <= (node.nodeType === 3 ? (node as Text).length : node.childNodes.length);
	}
	if (!valid(range.startContainer, range.startOffset) || !valid(range.endContainer, range.endOffset)) return null;
	const anchor = pathInputOffset(root, range.startContainer, range.startOffset);
	const focus = pathInputOffset(root, range.endContainer, range.endOffset);
	return anchor === null || focus === null || anchor >= focus ? null : { anchor, focus };
}

export function readPathSelection(root: HTMLElement): TextSelection | null {
	const selection = root.ownerDocument.getSelection?.();
	if (!selection?.anchorNode || !selection.focusNode) return null;
	const anchor = pathInputOffset(root, selection.anchorNode, selection.anchorOffset);
	const focus = pathInputOffset(root, selection.focusNode, selection.focusOffset);
	return anchor === null || focus === null ? null : { anchor, focus };
}

export function restorePathSelection(root: HTMLElement, selection: TextSelection): void {
	const browserSelection = root.ownerDocument.getSelection?.();
	if (!browserSelection) return;
	const anchor = pathInputPoint(root, selection.anchor);
	const focus = pathInputPoint(root, selection.focus);
	browserSelection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

/** Returns portal hosts. React owns only their visual contents, never the editable tree. */
export function renderPathInput(root: HTMLElement, value: string): Array<{ host: HTMLElement; path: string }> {
	const document = root.ownerDocument;
	const fragment = document.createDocumentFragment();
	const chips: Array<{ host: HTMLElement; path: string }> = [];
	for (const part of parseFilePaths(value)) {
		if (part.kind === "text") {
			fragment.append(document.createTextNode(part.text));
		} else {
			const host = document.createElement("span");
			host.contentEditable = "false";
			host.setAttribute("contenteditable", "false");
			host.setAttribute(PATH_SOURCE_ATTRIBUTE, part.text);
			fragment.append(host);
			chips.push({ host, path: part.path });
		}
	}
	// Empty boundary text nodes allow a caret immediately before/after an atomic chip.
	if (!fragment.firstChild || fragment.firstChild.nodeType !== 3) fragment.prepend(document.createTextNode(""));
	if (fragment.lastChild?.nodeType !== 3) fragment.append(document.createTextNode(""));
	if (value.endsWith("\n")) {
		// pre-wrap alone collapses the final empty line. This BR supplies its
		// height/caret without adding a second newline to the stored source.
		const caret = document.createElement("br");
		caret.setAttribute(PATH_CARET_ATTRIBUTE, "");
		caret.setAttribute("aria-hidden", "true");
		fragment.append(caret);
	}
	root.replaceChildren(fragment);
	root.dataset.empty = value.length === 0 ? "true" : "false";
	return chips;
}

export function clampPathSelection(value: string, selection: TextSelection): TextSelection {
	const clamp = (offset: number) => Math.min(value.length, Math.max(0, offset));
	return { anchor: clamp(selection.anchor), focus: clamp(selection.focus) };
}

/** A selection intersecting any part of a chip edits/copies that complete source. */
export function atomicPathRange(value: string, selection: TextSelection): { start: number; end: number } {
	const clamped = clampPathSelection(value, selection);
	let start = Math.min(clamped.anchor, clamped.focus);
	let end = Math.max(clamped.anchor, clamped.focus);
	for (const part of parseFilePaths(value)) {
		if (part.kind !== "path") continue;
		if (start > part.start && start < part.end) start = part.start;
		if (end > part.start && end < part.end) end = part.end;
	}
	return { start, end };
}

export function replacePathSelection(value: string, selection: TextSelection, text: string) {
	const { start, end } = atomicPathRange(value, selection);
	return { value: value.slice(0, start) + text + value.slice(end), selection: { anchor: start + text.length, focus: start + text.length } };
}

export function insertFilePaths(value: string, selection: TextSelection, paths: string[]) {
	const { start, end } = atomicPathRange(value, selection);
	const text = paths.map(quoteFilePath).join(" ");
	if (!text) return { value, selection };
	const before = start > 0 && !/\s/.test(value[start - 1]!) ? " " : "";
	const after = end < value.length && !/\s/.test(value[end]!) ? " " : "";
	return replacePathSelection(value, selection, before + text + after);
}

export function adjacentPathRange(value: string, selection: TextSelection, direction: "backward" | "forward"): TextSelection | null {
	if (selection.anchor !== selection.focus) return selection;
	const caret = selection.focus;
	for (const part of parseFilePaths(value)) {
		if (part.kind === "path" && (direction === "backward" ? caret > part.start && caret <= part.end : caret >= part.start && caret < part.end)) {
			return { anchor: part.start, focus: part.end };
		}
	}
	return null;
}

export type PathEditSnapshot = { value: string; selection: TextSelection };

/** Match the text input value sanitization algorithm: remove CR/LF, not spaces. */
export function normalizePathInputValue(value: string, singleLine: boolean): string {
	return singleLine ? value.replace(/[\r\n]/g, "") : value;
}

export function normalizePathEdit(snapshot: PathEditSnapshot, singleLine: boolean): PathEditSnapshot {
	if (!singleLine) return snapshot;
	const selection = clampPathSelection(snapshot.value, snapshot.selection);
	return {
		value: normalizePathInputValue(snapshot.value, true),
		selection: {
			anchor: normalizePathInputValue(snapshot.value.slice(0, selection.anchor), true).length,
			focus: normalizePathInputValue(snapshot.value.slice(0, selection.focus), true).length,
		},
	};
}

/** Independent of the browser's DOM undo stack (normalization replaces native nodes). */
export class PathInputHistory {
	private undoStack: PathEditSnapshot[] = [];
	private redoStack: PathEditSnapshot[] = [];
	push(snapshot: PathEditSnapshot) {
		this.undoStack.push({ value: snapshot.value, selection: { ...snapshot.selection } });
		this.redoStack = [];
	}
	reset() { this.undoStack = []; this.redoStack = []; }
	undo(current: PathEditSnapshot): PathEditSnapshot | null {
		const previous = this.undoStack.pop();
		if (!previous) return null;
		this.redoStack.push(current);
		return previous;
	}
	redo(current: PathEditSnapshot): PathEditSnapshot | null {
		const next = this.redoStack.pop();
		if (!next) return null;
		this.undoStack.push(current);
		return next;
	}
}

import React, { act, StrictMode } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import katex from "katex";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import CopySelectionAsMarkdown from "../components/copy-selection-as-markdown.tsx";
import { handleCopyAsMarkdown, selectionToMarkdown } from "../components/copy-selection-markdown.ts";

function renderMessageDom(markdown: string) {
	const html = renderToStaticMarkup(<MessageResponse mode="static">{markdown}</MessageResponse>);
	return parseHTML(`<!doctype html><html><body><div id="mount">${html}</div></body></html>`);
}

function createFakeRange(
	initialStart: Node,
	initialStartOffset: number,
	initialEnd: Node,
	initialEndOffset: number,
	collapsed = false,
): Range {
	let startContainer = initialStart;
	let startOffset = initialStartOffset;
	let endContainer = initialEnd;
	let endOffset = initialEndOffset;
	const range = {
		get startContainer() {
			return startContainer;
		},
		get startOffset() {
			return startOffset;
		},
		get endContainer() {
			return endContainer;
		},
		get endOffset() {
			return endOffset;
		},
		collapsed,
		get commonAncestorContainer(): Node {
			let current: Node | null = startContainer;
			while (current) {
				if (current === endContainer || current.contains(endContainer)) {
					return current;
				}
				current = current.parentNode;
			}
			return startContainer.ownerDocument?.body ?? startContainer;
		},
		cloneRange() {
			return createFakeRange(startContainer, startOffset, endContainer, endOffset, collapsed);
		},
		setStartBefore(node: Node) {
			startContainer = node;
			startOffset = 0;
		},
		setEndAfter(node: Node) {
			endContainer = node;
			endOffset = node.childNodes.length;
		},
		cloneContents() {
			const doc = startContainer.ownerDocument!;
			const fragment = doc.createDocumentFragment();
			const common = range.commonAncestorContainer;

			if (range.startContainer === range.endContainer) {
				if (range.startContainer.nodeType === 3) {
					const text = (range.startContainer as Text).data.slice(range.startOffset, range.endOffset);
					fragment.appendChild(doc.createTextNode(text));
					return fragment;
				}
				if (range.startOffset === 0 && range.endOffset === range.startContainer.childNodes.length) {
					fragment.appendChild(range.startContainer.cloneNode(true));
					return fragment;
				}
			}

			// Walk common ancestor and collect all intersecting top-level/partial slices
			// using standard tree traversal from startContainer..endContainer.
			const cloneBetween = (root: Node): Node | null => {
				if (root === range.startContainer && root === range.endContainer) {
					return root.cloneNode(true);
				}
				const containsStart = root === range.startContainer || root.contains(range.startContainer);
				const containsEnd = root === range.endContainer || root.contains(range.endContainer);
				if (!containsStart && !containsEnd) {
					return isAfterOrAtStart(root) && isBeforeOrAtEnd(root) ? root.cloneNode(true) : null;
				}
				if (root.nodeType === 3) {
				const data = (root as Text).data;
				const from = root === range.startContainer ? range.startOffset : 0;
				const to = root === range.endContainer ? range.endOffset : data.length;
				const slice = data.slice(from, to);
				return slice.length > 0 ? doc.createTextNode(slice) : null;
			}
			const clone = root.cloneNode(false);
			const children = Array.from(root.childNodes);
			const fromIndex = root === range.startContainer ? range.startOffset : 0;
			const toIndex = root === range.endContainer ? range.endOffset : children.length;
			for (let i = fromIndex; i < toIndex; i++) {
				const clonedChild = cloneBetween(children[i]!);
				if (clonedChild) clone.appendChild(clonedChild);
			}
			return clone.childNodes.length > 0 || isSelfClosing(root) ? clone : null;
		};

		const docOrder: Node[] = [];
		const walk = (n: Node) => {
			docOrder.push(n);
			for (const child of Array.from(n.childNodes)) walk(child);
		};
		walk(common);
		const startTarget =
			range.startContainer.nodeType === 3
				? range.startContainer
				: (range.startContainer.childNodes[range.startOffset] ?? range.startContainer);
		const startIdx = docOrder.indexOf(startTarget);
		const subtreeEndIdx = (node: Node) => {
			let last = docOrder.indexOf(node);
			for (let i = last + 1; i < docOrder.length; i++) {
				if (!node.contains(docOrder[i]!)) break;
				last = i;
			}
			return last;
		};
		const endIdx =
			range.endContainer.nodeType === 3 || range.endOffset === 0
				? docOrder.indexOf(range.endContainer)
				: subtreeEndIdx(range.endContainer.childNodes[range.endOffset - 1] ?? range.endContainer);
		const isAfterOrAtStart = (node: Node) => subtreeEndIdx(node) >= startIdx;
		const isBeforeOrAtEnd = (node: Node) => docOrder.indexOf(node) <= endIdx;
		const isSelfClosing = (node: Node) => node.nodeName === "BR" || node.nodeName === "HR";

		if (common === range.startContainer && common === range.endContainer) {
			if (range.startOffset === 0 && range.endOffset === common.childNodes.length) {
				fragment.appendChild(common.cloneNode(true));
				return fragment;
			}
			for (let i = range.startOffset; i < range.endOffset; i++) {
				fragment.appendChild(common.childNodes[i]!.cloneNode(true));
			}
			return fragment;
		}
		for (const child of Array.from(common.childNodes)) {
			const cloned = cloneBetween(child);
			if (cloned) fragment.appendChild(cloned);
		}
		return fragment;
		},
	} as unknown as Range;
	return range;
}

function dispatchCopy(
	doc: Document,
	range: Range,
	target: EventTarget | null = null,
	defaultPrevented = false,
): { intercepted: boolean; prevented: boolean; plainText: string | null } {
	const store = new Map<string, string>();
	let prevented = defaultPrevented;
	(doc as unknown as { getSelection: () => Selection }).getSelection = () =>
		({
			isCollapsed: range.collapsed,
			rangeCount: 1,
			getRangeAt: () => range,
		}) as unknown as Selection;

	const event = {
		defaultPrevented,
		target: target ?? range.startContainer,
		clipboardData: {
			setData: (type: string, data: string) => store.set(type, data),
		},
		preventDefault: () => {
			prevented = true;
		},
	};
	const intercepted = handleCopyAsMarkdown(event, doc);
	return {
		intercepted,
		prevented,
		plainText: store.get("text/plain") ?? null,
	};
}

describe("selectionToMarkdown & handleCopyAsMarkdown", () => {
	it("copies a standalone display equation selected inside .katex-html with $$ delimiters (fixes PR #481/#529 degradation)", () => {
		const md = "Before.\n\n$$\n\\sum_{k=1}^{5} k\n$$\n\nAfter.";
		const { document } = renderMessageDom(md);
		const displayHtml = document.querySelector('[data-testid="md-math"] .katex-html')!;
		const firstText = displayHtml.querySelector(".mord") ?? displayHtml;
		const lastText = Array.from(displayHtml.querySelectorAll("span")).at(-1) ?? displayHtml;

		const range = createFakeRange(firstText, 0, lastText, lastText.childNodes.length);
		const result = dispatchCopy(document, range);

		assert.equal(result.intercepted, true);
		assert.equal(result.prevented, true);
		assert.equal(result.plainText, "$$\n\\sum_{k=1}^{5} k\n$$");
	});

	it("copies raw KaTeX displayMode output with $$ even when md-math wrapper is absent", () => {
		const blockHtml = katex.renderToString("\\sigma'(z) \\le \\frac14", { displayMode: true, throwOnError: false });
		const { document } = parseHTML(`<!doctype html><html><body><div id="root">${blockHtml}</div></body></html>`);
		const inner = document.querySelector(".katex-html")!;
		const range = createFakeRange(inner, 0, inner, inner.childNodes.length);

		assert.equal(selectionToMarkdown(range, document), "$$\n\\sigma'(z) \\le \\frac14\n$$");
	});

	it("copies inline math inside prose as $...$ cleanly trimmed", () => {
		const md = "Gradient by $\\sigma'(z) \\le \\frac14$ done.";
		const { document } = renderMessageDom(md);
		const p = document.querySelector(".lh-prose p")!;
		const range = createFakeRange(p.firstChild!, 0, p.lastChild!, (p.lastChild as Text).data.length);

		assert.equal(selectionToMarkdown(range, document), "Gradient by $\\sigma'(z) \\le \\frac14$ done.");
	});

	it("converts rich multi-block selection (headings, formatting, math, lists, callout, blockquote, table, fenced code) to standard Markdown", () => {
		const md = [
			"# Heading 1",
			"",
			"Text **bold**, *italic*, ~~strike~~, `inline()`, and $\\sigma(z) = \\frac{1}{1+e^{-z}}$ plus [link](https://example.com).",
			"",
			"$$",
			"\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
			"$$",
			"",
			"- item 1",
			"  - nested item",
			"1. first",
			"2. second",
			"",
			"> [!IMPORTANT]",
			"> key callout",
			"",
			"> plain quote",
			"",
			"| A | B |",
			"| --- | --- |",
			"| $\\lvert x\\rvert$ | `val` |",
			"| a \\| b | c |",
			"",
			"```python",
			"def f(x):",
			"    return x + 1",
			"",
			"def g(y):",
			"    return y * 2",
			"```",
		].join("\n");

		const { document } = renderMessageDom(md);
		const prose = document.querySelector(".lh-prose")!;
		const range = createFakeRange(prose, 0, prose, prose.childNodes.length);
		const result = dispatchCopy(document, range);

		assert.equal(result.intercepted, true);
		assert.equal(
			result.plainText,
			[
				"# Heading 1",
				"",
				"Text **bold**, *italic*, ~~strike~~, `inline()`, and $\\sigma(z) = \\frac{1}{1+e^{-z}}$ plus link.",
				"",
				"$$",
				"\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
				"$$",
				"",
				"- item 1",
				"  - nested item",
				"",
				"1. first",
				"2. second",
				"",
				"> [!IMPORTANT]",
				"> key callout",
				"",
				"> plain quote",
				"",
				"| A | B |",
				"| --- | --- |",
				"| $\\lvert x\\rvert$ | `val` |",
				"| a \\| b | c |",
				"",
				"```python",
				"def f(x):",
				"    return x + 1",
				"",
				"def g(y):",
				"    return y * 2",
				"```",
			].join("\n"),
		);
	});

	it("converts legacy \\(...\\) and \\[...\\] formulas rendered via MessageResponse into $...$ and $$...$$", () => {
		const md = "Inline \\(x^2\\) and block:\n\n\\[\n\\int_0^1 x\\,dx\n\\]";
		const { document } = renderMessageDom(md);
		const prose = document.querySelector(".lh-prose")!;
		const range = createFakeRange(prose, 0, prose, prose.childNodes.length);

		assert.equal(
			selectionToMarkdown(range, document),
			"Inline $x^2$ and block:\n\n$$\n\\int_0^1 x\\,dx\n$$",
		);
	});

	it("preserves newlines and suppresses Markdown escaping when copying multi-line selections strictly inside a code block", () => {
		const md = "```python\na_1 = b_2 * c_3\nreturn a_1\n```";
		const { document } = renderMessageDom(md);
		const codeEl = document.querySelector('[data-testid="md-code"] pre code')!;
		const lines = Array.from(codeEl.children);
		const range = createFakeRange(lines[0]!, 0, lines[1]!, lines[1]!.childNodes.length);

		assert.equal(selectionToMarkdown(range, document), "a_1 = b_2 * c_3\nreturn a_1");
	});

	it("leaves non-prose UI, user plain-text prompts, editable controls, collapsed selections, and handled events untouched", () => {
		const { document } = parseHTML(`<!doctype html><html><body>
			<aside><span id="nav">Calculus 101</span></aside>
			<div id="user" class="lh-prose whitespace-pre-wrap"># literal *stars*</div>
			<textarea id="ta">input text</textarea>
			<div id="ce" contenteditable="true" data-file-path-input="">draft text</div>
		</body></html>`);

		const navText = document.getElementById("nav")!.firstChild!;
		assert.equal(dispatchCopy(document, createFakeRange(navText, 0, navText, 8)).intercepted, false);

		const userText = document.getElementById("user")!.firstChild!;
		assert.equal(dispatchCopy(document, createFakeRange(userText, 0, userText, 17)).intercepted, false);

		const ta = document.getElementById("ta")!;
		assert.equal(dispatchCopy(document, createFakeRange(ta.firstChild!, 0, ta.firstChild!, 5), ta).intercepted, false);

		const ceText = document.getElementById("ce")!.firstChild!;
		assert.equal(dispatchCopy(document, createFakeRange(ceText, 0, ceText, 5), ceText).intercepted, false);

		assert.equal(dispatchCopy(document, createFakeRange(navText, 0, navText, 0, true)).intercepted, false);
		assert.equal(dispatchCopy(document, createFakeRange(navText, 0, navText, 5), navText, true).intercepted, false);
	});

	it("mounts a single global copy listener via CopySelectionAsMarkdown and cleans it up on unmount", async () => {
		const html = renderToStaticMarkup(<MessageResponse mode="static">{"Inline $E=mc^2$."}</MessageResponse>);
		const dom = parseHTML(`<!doctype html><html><body><div id="msg">${html}</div><div id="host"></div></body></html>`);
		const { document, window } = dom;

		const listeners: Array<(e: unknown) => void> = [];
		const origAdd = document.addEventListener.bind(document);
		const origRemove = document.removeEventListener.bind(document);
		document.addEventListener = ((type: string, fn: (e: unknown) => void, ...rest: unknown[]) => {
			if (type === "copy") listeners.push(fn);
			return (origAdd as (...args: unknown[]) => void)(type, fn, ...rest);
		}) as typeof document.addEventListener;
		document.removeEventListener = ((type: string, fn: (e: unknown) => void, ...rest: unknown[]) => {
			if (type === "copy") {
				const idx = listeners.indexOf(fn);
				if (idx !== -1) listeners.splice(idx, 1);
			}
			return (origRemove as (...args: unknown[]) => void)(type, fn, ...rest);
		}) as typeof document.removeEventListener;

		const prev = Object.getOwnPropertyDescriptors(globalThis);
		Object.assign(globalThis, {
			window,
			document,
			Element: window.Element,
			Text: window.Text,
			HTMLElement: window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		});

		try {
			const root = createRoot(document.getElementById("host")!);
			await act(async () => root.render(<StrictMode><CopySelectionAsMarkdown /></StrictMode>));
			assert.equal(listeners.length, 1);

			const p = document.querySelector(".lh-prose p")!;
			const range = createFakeRange(p.firstChild!, 0, p.lastChild!, (p.lastChild as Text).data.length);
			(document as unknown as { getSelection: () => Selection }).getSelection = () =>
				({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range }) as unknown as Selection;

			const clipboard = new Map<string, string>();
			let prevented = false;
			listeners[0]!({
				defaultPrevented: false,
				target: p,
				clipboardData: { setData: (k: string, v: string) => clipboard.set(k, v) },
				preventDefault: () => { prevented = true; },
			});
			assert.equal(prevented, true);
			assert.equal(clipboard.get("text/plain"), "Inline $E=mc^2$.");

			await act(async () => root.unmount());
			assert.equal(listeners.length, 0);
		} finally {
			for (const key of Object.keys(globalThis)) {
				if (!(key in prev)) delete (globalThis as Record<string, unknown>)[key];
			}
			Object.defineProperties(globalThis, prev);
		}
	});
});

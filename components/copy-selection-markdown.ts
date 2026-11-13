import TurndownService from "turndown";

const TEX_ANNOTATION_SELECTOR = 'annotation[encoding="application/x-tex"], annotation';
const PROSE_SURFACE_SELECTOR = '.lh-prose:not(.whitespace-pre-wrap), .katex, .katex-display, [data-streamdown], [data-testid^="md-"]';
const DISPLAY_MATH_SELECTOR = '[data-testid="md-math"], .katex-display';
const CODE_WRAPPER_SELECTOR = '[data-testid="md-code"], [data-streamdown="code-block"], [data-streamdown="code-block-body"]';
const CHROME_SELECTOR = [
	'[data-testid="md-copy"]',
	'[data-testid="md-mermaid-expand"]',
	'[data-testid="copy-response-button"]',
	'[data-testid="side-conversation-button"]',
	'[data-testid="tool-retry"]',
	'[data-testid="citation-quote-card"]',
	'[data-testid="md-mermaid"] svg',
	'[data-streamdown="code-block-header"]',
].join(", ");

export interface ClipboardDataLike {
	setData(format: string, data: string): void;
}

export interface CopyEventLike {
	defaultPrevented: boolean;
	target: EventTarget | null;
	clipboardData: ClipboardDataLike | null;
	preventDefault(): void;
}

function elementOf(node: Node | null | undefined): Element | null {
	if (!node) return null;
	return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function isEditableNode(node: Node | null | undefined): boolean {
	const el = elementOf(node);
	if (!el) return false;
	if (el.closest("input, textarea, select, [data-file-path-input]")) return true;
	const contentEditableHost = el.closest("[contenteditable]");
	return contentEditableHost !== null && contentEditableHost.getAttribute("contenteditable") !== "false";
}

function enclosingMathContainer(node: Node | null | undefined): Element | null {
	const el = elementOf(node);
	if (!el) return null;
	return el.closest('[data-testid="md-math"]') ?? el.closest(".katex-display") ?? el.closest(".katex");
}

function isDisplayMathNode(el: Element): boolean {
	if (el.getAttribute("data-testid") === "md-math") return true;
	return el.classList.contains("katex-display") && !el.closest('[data-testid="md-math"]');
}

function isInlineMathNode(el: Element): boolean {
	return el.classList.contains("katex") && !isDisplayMathNode(el) && !el.closest(DISPLAY_MATH_SELECTOR);
}

function extractTex(el: Element): string | null {
	const raw = el.querySelector(TEX_ANNOTATION_SELECTOR)?.textContent ?? "";
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function extractCodeLanguage(el: Element): string {
	const direct = el.getAttribute("data-language");
	if (direct) return direct;
	const nested = el.querySelector("[data-language]")?.getAttribute("data-language");
	if (nested) return nested;
	const targets = [el, el.querySelector("pre"), el.querySelector("code")];
	for (const candidate of targets) {
		const className = candidate?.getAttribute("class") ?? "";
		const match = /(?:^|\s)language-([^\s]+)/.exec(className);
		if (match?.[1]) return match[1];
	}
	return "";
}

function blockLineChildren(container: Element): Element[] {
	return Array.from(container.children).filter((child) => child.classList?.contains("block"));
}

function extractCodeText(el: Element): string {
	const codeEl = el.nodeName === "CODE" ? el : (el.querySelector("pre code") ?? el.querySelector("code"));
	const lineContainer = codeEl ?? el;
	const blockLines = blockLineChildren(lineContainer);
	if (blockLines.length > 0) {
		return blockLines.map((line) => (line.textContent ?? "").replace(/\r?\n$/, "")).join("\n");
	}
	return (codeEl?.textContent ?? el.textContent ?? "").replace(/\r?\n$/, "");
}

function longestBacktickRun(text: string): number {
	let max = 0;
	for (const match of text.matchAll(/`+/g)) {
		if (match[0].length > max) max = match[0].length;
	}
	return max;
}

function escapeProsePipes(text: string): string {
	// Keep literal pipes inside inline math ($...$) or code (`...`) unescaped.
	return text.replace(/(`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$]*\$|\|)/g, (token) => (token === "|" ? "\\|" : token));
}

function tableCellAlignment(cell: Element): string {
	const alignAttr = cell.getAttribute("align")?.toLowerCase();
	const style = cell.getAttribute("style")?.toLowerCase() ?? "";
	const match = /text-align\s*:\s*(left|center|right)/.exec(style);
	const align = match?.[1] ?? alignAttr;
	if (align === "center") return ":---:";
	if (align === "right") return "---:";
	if (align === "left") return ":---";
	return "---";
}

function stripUiChrome(root: Element): void {
	for (const chrome of Array.from(root.querySelectorAll(CHROME_SELECTOR))) {
		chrome.remove();
	}
}

function preservePreWrapNewlines(root: Element, doc: Document): void {
	for (const host of Array.from(root.querySelectorAll(".whitespace-pre-wrap"))) {
		if (host.closest(`pre, code, .katex, ${CODE_WRAPPER_SELECTOR}`)) continue;
		const collectTextNodes = (current: Node, out: Text[]) => {
			if (current.nodeType === 3) {
				if ((current as Text).data.includes("\n")) out.push(current as Text);
				return;
			}
			if (current.nodeType !== 1) return;
			const el = current as Element;
			if (el.matches?.("pre, code, .katex, .katex-display, [data-testid='md-math']")) return;
			for (const child of Array.from(current.childNodes)) collectTextNodes(child, out);
		};
		const textNodes: Text[] = [];
		collectTextNodes(host, textNodes);
		for (const textNode of textNodes) {
			const parts = textNode.data.split("\n");
			const parent = textNode.parentNode;
			if (!parent) continue;
			const fragment = doc.createDocumentFragment();
			parts.forEach((part, index) => {
				if (index > 0) fragment.appendChild(doc.createElement("br"));
				if (part.length > 0) fragment.appendChild(doc.createTextNode(part));
			});
			parent.replaceChild(fragment, textNode);
		}
	}
}

function isOutermostCodeWrapper(el: Element): boolean {
	if (el.matches(CODE_WRAPPER_SELECTOR)) {
		return !el.parentElement?.closest(CODE_WRAPPER_SELECTOR);
	}
	return el.nodeName === "PRE" && !el.parentElement?.closest(CODE_WRAPPER_SELECTOR);
}

function createMarkdownTurndownService(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		br: "",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		fence: "```",
		emDelimiter: "*",
		strongDelimiter: "**",
		linkStyle: "inlined",
	});

	service.addRule("lineBreak", {
		filter: "br",
		replacement: () => "\n",
	});

	service.addRule("listItem", {
		filter: "li",
		replacement: (content, node, options) => {
			const parent = node.parentNode as Element | null;
			let prefix = `${options.bulletListMarker ?? "-"} `;
			if (parent && parent.nodeName === "OL") {
				const start = parent.getAttribute("start");
				const index = Array.from(parent.children).indexOf(node);
				const number = start ? Number(start) + index : index + 1;
				prefix = `${number}. `;
			}
			const hasTrailingParagraphBreak = /\n$/.test(content);
			const cleaned = content.replace(/^\n+/, "").replace(/\n+$/, "") + (hasTrailingParagraphBreak ? "\n" : "");
			const indent = " ".repeat(prefix.length);
			const indented = cleaned.replace(/\n(?=[^\n])/gm, `\n${indent}`);
			return `${prefix}${indented}${node.nextSibling ? "\n" : ""}`;
		},
	});

	service.addRule("strikethrough", {
		filter: ["del", "s"],
		replacement: (content) => `~~${content}~~`,
	});

	service.addRule("streamdownLink", {
		filter: (node) => node.nodeName === "BUTTON" && node.getAttribute("data-streamdown") === "link",
		replacement: (content) => content,
	});

	service.addRule("displayMath", {
		filter: (node) => isDisplayMathNode(node),
		replacement: (_content, node) => {
			const tex = extractTex(node);
			if (!tex) return "";
			if (node.closest("td, th")) {
				return `$$${tex.replace(/\s*\n+\s*/g, " ")}$$`;
			}
			return `\n\n$$\n${tex}\n$$\n\n`;
		},
	});

	service.addRule("inlineMath", {
		filter: (node) => isInlineMathNode(node),
		replacement: (_content, node) => {
			const tex = extractTex(node);
			return tex ? `$${tex}$` : "";
		},
	});

	service.addRule("fencedCodeBlock", {
		filter: (node) => isOutermostCodeWrapper(node),
		replacement: (_content, node) => {
			const language = extractCodeLanguage(node);
			const code = extractCodeText(node);
			const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
			return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
		},
	});

	service.addRule("calloutAlert", {
		filter: (node) => node.getAttribute?.("data-testid") === "md-callout" && node.hasAttribute("data-alert-kind"),
		replacement: (content, node) => {
			const kind = (node.getAttribute("data-alert-kind") || "note").toUpperCase();
			const trimmed = content.trim();
			if (!trimmed) return `\n\n> [!${kind}]\n\n`;
			const quotedBody = trimmed
				.split("\n")
				.map((line) => (line.length > 0 ? `> ${line}` : ">"))
				.join("\n");
			return `\n\n> [!${kind}]\n${quotedBody}\n\n`;
		},
	});

	service.addRule("gfmTable", {
		filter: "table",
		replacement: (_content, node) => {
			const rows = Array.from(node.querySelectorAll("tr")).filter((row) => row.closest("table") === node);
			if (rows.length === 0) return "";
			const cellsOf = (row: Element) =>
				Array.from(row.children).filter((cell) => cell.nodeName === "TH" || cell.nodeName === "TD");
			const headerCells = cellsOf(rows[0]!);
			if (headerCells.length === 0) return "";

			const formatRow = (cells: Element[]) =>
				`| ${cells
					.map((cell) => escapeProsePipes(service.turndown(cell as HTMLElement).replace(/\s*\n+\s*/g, " ").trim()))
					.join(" | ")} |`;

			const separator = `| ${headerCells.map(tableCellAlignment).join(" | ")} |`;
			const lines = [formatRow(headerCells), separator];
			for (const bodyRow of rows.slice(1)) {
				const cells = cellsOf(bodyRow);
				if (cells.length === 0) continue;
				lines.push(formatRow(cells));
			}
			return `\n\n${lines.join("\n")}\n\n`;
		},
	});

	return service;
}

const sharedTurndownService = createMarkdownTurndownService();

function isProseSelection(range: Range, fragmentRoot: Element): boolean {
	const endpoints = [range.commonAncestorContainer, range.startContainer, range.endContainer];
	if (endpoints.some((node) => elementOf(node)?.closest(PROSE_SURFACE_SELECTOR) !== null)) {
		return true;
	}
	return fragmentRoot.querySelector(PROSE_SURFACE_SELECTOR) !== null;
}

/** Convert a live DOM selection range into standard Markdown, expanding endpoints
 *  outward to complete `.katex-display` / `.katex` wrappers and preserving
 *  code fences, GFM tables, lists, callouts, and prose formatting. Returns `null`
 *  for non-prose/editable selections so the browser handles normal copy. */
export function selectionToMarkdown(range: Range, doc: Document): string | null {
	if (range.collapsed) return null;
	if (isEditableNode(range.startContainer) || isEditableNode(range.endContainer)) {
		return null;
	}

	const expanded = range.cloneRange();
	const startMath = enclosingMathContainer(expanded.startContainer);
	if (startMath?.parentNode) expanded.setStartBefore(startMath);
	const endMath = enclosingMathContainer(expanded.endContainer);
	if (endMath?.parentNode) expanded.setEndAfter(endMath);

	const root = doc.createElement("div");
	root.appendChild(expanded.cloneContents());

	if (!isProseSelection(expanded, root)) return null;

	// Selections contained entirely inside <pre><code> (e.g., copying two lines
	// without the surrounding code wrapper) should stay verbatim without Markdown escaping.
	const commonEl = elementOf(expanded.commonAncestorContainer);
	if (commonEl?.closest("pre") && !root.querySelector(CODE_WRAPPER_SELECTOR) && !root.querySelector("pre")) {
		const blockLines = blockLineChildren(root);
		if (blockLines.length > 0) {
			return blockLines.map((line) => (line.textContent ?? "").replace(/\r?\n$/, "")).join("\n");
		}
		return (root.textContent ?? "").replace(/\r?\n$/, "");
	}

	stripUiChrome(root);
	preservePreWrapNewlines(root, doc);

	const markdown = sharedTurndownService.turndown(root as HTMLElement).trim();
	return markdown.length > 0 ? markdown : null;
}

/** Handle a `copy` event if the selection belongs to rendered teaching prose or
 *  math, writing standard Markdown (`$...$` / `$$...$$`) to `text/plain`. */
export function handleCopyAsMarkdown(event: CopyEventLike, doc: Document): boolean {
	if (event.defaultPrevented || !event.clipboardData) return false;
	if (isEditableNode(event.target as Node | null)) return false;

	const win = doc.defaultView;
	const selection = (typeof doc.getSelection === "function" ? doc.getSelection() : null) ?? win?.getSelection?.() ?? null;
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

	const markdown = selectionToMarkdown(selection.getRangeAt(0), doc);
	if (markdown === null) return false;

	event.clipboardData.setData("text/plain", markdown);
	event.preventDefault();
	return true;
}

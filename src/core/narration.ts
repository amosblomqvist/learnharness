import { fromMarkdown } from "mdast-util-from-markdown";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { RootContent, Root } from "mdast";
import { repairMathForDisplay, transformMathDelimiters } from "./math-delims.ts";

/** Buffer syntax that could later change the meaning of already-visible bytes. */
export function completeMarkdownPrefix(markdown: string): string {
	let fence: { marker: string; offset: number } | undefined;
	const fencedRanges: { start: number; end: number }[] = [];
	let offset = 0;
	for (const line of markdown.split(/(?<=\n)/)) {
		const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (match) {
			if (!fence) fence = { marker: match[1]!, offset };
			else if (match[1]![0] === fence.marker[0] && match[1]!.length >= fence.marker.length) {
				fencedRanges.push({ start: fence.offset, end: offset + line.length });
				fence = undefined;
			}
		}
		offset += line.length;
	}
	if (fence) markdown = markdown.slice(0, fence.offset);
	// Unclosed inline code, math, or link/image labels stay buffered. Escaped delimiters are literal.
	const stack: { char: string; offset: number }[] = [];
	for (let i = 0; i < markdown.length; i++) {
		const range = fencedRanges.find(range => range.start === i);
		if (range) { i = range.end - 1; continue; }
		const char = markdown[i]!;
		if (char === "\\") {
			if ((markdown[i + 1] === "(" || markdown[i + 1] === "[") && !stack.length) return markdown.slice(0, i);
			i++; continue;
		}
		const top = stack.at(-1);
		if (char === "`" || char === "$") {
			let end = i + 1;
			while (markdown[end] === char) end++;
			const marker = markdown.slice(i, end);
			if (top?.char === marker) stack.pop();
			else if (!top || top.char === "[") stack.push({ char: marker, offset: i });
			i = end - 1;
			continue;
		}
		if (top && top.char !== "[") continue;
		if (char === "[") stack.push({ char, offset: i });
		else if (char === "]" && top?.char === "[") {
			stack.pop();
			if (markdown[i + 1] === "(") {
				const end = markdown.indexOf(")", i + 2);
				if (end < 0) return markdown.slice(0, top.offset);
				i = end;
			}
		}
	}
	return stack.length ? markdown.slice(0, stack[0]!.offset) : markdown;
}

/** Words, names and simple identifiers (including a single symbol or number) read as themselves; code and formulas do not. */
export function speakableWords(value: string): string | null {
	const text = value.trim();
	return /^[\p{L}\p{N}][\p{L}\p{N} _'’-]{0,60}$/u.test(text) ? text : null;
}

/** Structural projection, never regex-stripped prose or model-authored narration. */
export function markdownNarration(markdown: string, complete = true): string {
	// GitHub-style alert markers are presentation, not content: "> [!IMPORTANT] text" reads as "text".
	markdown = markdown.replace(/^([ \t]*>?[ \t]*)\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/gim, "$1");
	markdown = transformMathDelimiters(repairMathForDisplay(markdown));
	const tree = fromMarkdown(complete ? markdown : completeMarkdownPrefix(markdown), {
		extensions: [math(), gfmTable()], mdastExtensions: [mathFromMarkdown(), gfmTableFromMarkdown()],
	});
	function read(node: Root | RootContent): string {
		switch (node.type) {
			case "text": return node.value;
			case "code": return " Code omitted. ";
			case "inlineCode": return speakableWords(node.value) ?? " Code omitted ";
			// Simple inline math (a number or a single symbol) is spoken as itself;
			// anything more complex is announced rather than read as noise.
			// Inline math that is only words (\text{deposited}, $F$) is spoken; formulas are announced.
			case "inlineMath": return speakableWords(node.value.trim().replace(/^\\text\{([^{}]*)\}$/, "$1")) ?? " Equation omitted ";
			case "math": return " Equation omitted. ";
			case "image": return node.alt ? ` Image: ${node.alt}. ` : "";
			case "imageReference": return node.alt ? ` Image: ${node.alt}. ` : "";
			case "html": case "definition": case "thematicBreak": return "";
			case "break": return " ";
			case "table": {
				const headers = node.children[0]?.children.map(cell => cell.children.map(read).join("")) ?? [];
				return node.children.slice(1).map(row => row.children.map((cell, index) => `${headers[index] || `Column ${index + 1}`}: ${cell.children.map(read).join("")}`).join(". ") + ".").join("\n");
			}
			default: {
				if (!("children" in node)) return "";
				const separator = ["root", "list", "listItem", "blockquote"].includes(node.type) ? "\n" : "";
				const value = node.children.map(child => read(child as RootContent)).join(separator);
				return ["paragraph", "heading"].includes(node.type) ? `${value}\n` : value;
			}
		}
	}
	return read(tree).replace(/[ \t]+/g, " ").replace(/ +([.,;:!?])/g, "$1").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface NarrationSentence { text: string; end: number }
/** Sentence boundaries retain decimal and common abbreviation punctuation. */
export function narrationSentences(text: string, complete: boolean): NarrationSentence[] {
	const result: NarrationSentence[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (!/[.!?\n]/.test(char)) continue;
		if (char === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) continue;
		// A lone capital at the start of a line is a list label ("A. Choice"), not an initial: it ends a sentence.
		const beforePeriod = text.slice(start, index);
		const listLabel = /\n[ \t]*[A-Z]$/.test(beforePeriod);
		if (char === "." && !listLabel && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)|\b[A-Z]|\be\.g|\bi\.e)$/i.test(beforePeriod)) continue;
		let end = index + 1;
		while (/[.!?"'’”)]/.test(text[end] ?? "") && end < text.length) end++;
		// A finished sentence is spoken even while the reply streams, except a "." after a digit, which may still become "3.14".
		if (end === text.length && !complete && char === "." && /\d/.test(text[index - 1] ?? "")) continue;
		if (end < text.length && !/\s/.test(text[end]!) && char !== "\n") continue;
		const sentence = text.slice(start, end).trim();
		if (sentence) result.push({ text: sentence, end });
		start = end;
		index = end - 1;
	}
	if (complete && text.slice(start).trim()) result.push({ text: text.slice(start).trim(), end: text.length });
	return result.flatMap(sentence => {
		const bounded: NarrationSentence[] = [];
		let remaining = sentence.text;
		while (remaining.length > 1200) {
			let cut = remaining.lastIndexOf(" ", 1200);
			if (cut < 1) cut = 1200;
			if (/[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut--;
			bounded.push({ text: remaining.slice(0, cut).trim(), end: sentence.end - remaining.length + cut });
			remaining = remaining.slice(cut);
		}
		if (remaining.trim()) bounded.push({ text: remaining.trim(), end: sentence.end });
		// A punctuation-only fragment has nothing to say and would produce no audio.
		return bounded.filter(piece => /[\p{L}\p{N}]/u.test(piece.text));
	});
}

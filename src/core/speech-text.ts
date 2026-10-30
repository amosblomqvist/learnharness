/**
 * Markdown → speech (read aloud, ElevenLabs voice slice 6).
 *
 * The teacher writes markdown for the eye; the Listen button needs text for
 * the ear. This is the one pure conversion: markdown in, an ordered list of
 * chunks to speak out. Browser-safe, no DOM, no network.
 *
 *  - Prose flattens to plain sentences: headings and list items become
 *    sentences of their own, emphasis markers vanish, links read their label.
 *    A bare URL or autolink reads as its host name only (owner, 2026-10-29).
 *  - Whole blocks the ear can't use become ONE spoken marker each: fenced
 *    code, mermaid fences, tables and display math (owner 2026-10-29).
 *  - Inline math reads as words for the common forms (powers, fractions,
 *    subscripts, roots); anything else is read as its source with the
 *    backslashes and braces stripped.
 *  - Chunks split at paragraphs, then sentences. The first is short (~200
 *    characters) so speech starts fast; later ones stay under ~1000.
 *
 * Code / math boundaries come from the shared content reader (the same
 * CommonMark+math grammar the renderer uses), so what is skipped here is
 * exactly what the screen draws as a code block or an equation.
 */

import { readContentSpans } from "./content-reader.ts";

/** The spoken markers (owner, 2026-10-29): they name what was skipped. */
export const SPEECH_MARKERS = {
	code: "Code shown on screen.",
	diagram: "Diagram shown on screen.",
	table: "Table shown on screen.",
	equation: "Equation shown on screen.",
} as const;

/** First chunk ≤ ~200 characters (speech starts fast), the rest ≤ ~1000. */
export const FIRST_CHUNK_MAX = 200;
export const CHUNK_MAX = 1000;

// Private-use sentinels around an index into the held-text list: text that
// must reach the speech verbatim (inline math words, inline code, escaped
// characters) is parked here so the markdown cleanup can't touch it.
const HOLD_OPEN = "";
const HOLD_CLOSE = "";
const HELD = new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g");

/** Inline math → words. Exported for the pins; the chunker calls it. */
export function mathToSpeech(body: string): string {
	let s = body.replace(/\s+/g, " ").trim();
	// Nested fractions/roots resolve inside-out over a few passes.
	for (let pass = 0; pass < 3; pass++) {
		s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1 over $2");
		s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "square root of $1");
	}
	s = s.replace(/\^(?:\{\s*2\s*\}|2(?![\w.]))/g, " squared");
	s = s.replace(/\^(?:\{\s*3\s*\}|3(?![\w.]))/g, " cubed");
	s = s.replace(/\^\{([^{}]+)\}/g, " to the $1").replace(/\^(\w)/g, " to the $1");
	s = s.replace(/_\{([^{}]+)\}/g, " sub $1").replace(/_(\w)/g, " sub $1");
	s = s.replace(/(\w+)\s*\/\s*(\w+)/g, "$1 over $2");
	return s
		.replace(/\\[,;:! ]/g, " ")
		.replace(/[\\{}^_]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_BOX = /^\[[ xX]\]\s+/;

/** Make a heading or list item read as a sentence: a spoken pause, not a run-on. */
function asSentence(text: string): string {
	return /[.!?…:;]["')\]]*$/.test(text) ? text : `${text}.`;
}

const BARE_URL = /https?:\/\/[^\s<>]+/g;

/** A URL's host name, the only part worth hearing (owner, 2026-10-29). */
function urlHost(url: string): string {
	return /^https?:\/\/(?:[^@/?#\s]*@)?([^:/?#\s]+)/i.exec(url)?.[1] ?? url;
}

/** The URL proper: what a bare match carries after it (sentence punctuation,
 *  a closing bracket or emphasis marker) is not part of it. A `)` stays only
 *  when the URL opened its own `(`. */
function trimUrl(match: string): string {
	let url = match;
	for (;;) {
		const last = url[url.length - 1];
		const closesOwn = last === ")" && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0);
		if (last === undefined || !/[.,;:!?)\]'"*_~]/.test(last) || closesOwn) return url;
		url = url.slice(0, -1);
	}
}

/** One paragraph's inline markdown → plain words. */
function inlineText(paragraph: string, held: string[]): string {
	const hold = (text: string) => {
		held.push(text);
		return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
	};
	let s = paragraph
		.replace(/\\([\\`*_{}[\]()#+\-.!|~>$<])/g, (_, char: string) => hold(char))
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[\^[^\]]*\]/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => urlHost(url))
		.replace(/<\/?[A-Za-z][^>]*>/g, "")
			.replace(BARE_URL, (match) => {
				const url = trimUrl(match);
				return urlHost(url) + match.slice(url.length);
			})
		.replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
		.replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/g, "$1")
		.replace(/(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1");
	s = s.replace(/\s+/g, " ").trim();
	return s.replace(HELD, (_, index: string) => held[Number(index)]!);
}

/** Markdown → paragraphs of plain speech, markers included, in order. */
function speechParagraphs(markdown: string): string[] {
	const held: string[] = [];
	const hold = (text: string) => {
		held.push(text);
		return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
	};

	// Pass 1 — the content reader's spans: blocks become marker paragraphs,
	// inline code and inline math become held words.
	let work = "";
	for (const span of readContentSpans(markdown)) {
		if (span.kind === "prose") work += span.raw;
		else if (span.kind === "math") {
			work += span.display ? `\n\n${SPEECH_MARKERS.equation}\n\n` : hold(mathToSpeech(span.body));
		} else if (/^\s*(```|~~~)/.test(span.raw) || (span.raw.includes("\n") && !span.raw.startsWith("`"))) {
			const diagram = /^\s*(```|~~~)\s*mermaid\b/i.test(span.raw);
			work += `\n\n${diagram ? SPEECH_MARKERS.diagram : SPEECH_MARKERS.code}\n\n`;
		} else {
			work += hold(span.raw.replace(/^`+|`+$/g, "").replace(/\s+/g, " ").trim());
		}
	}

	// Pass 2 — block structure, line by line.
	const paragraphs: string[] = [];
	let current: string[] = [];
	let currentIsItem = false;
	const flush = () => {
		if (current.length > 0) {
			const text = inlineText(current.join(" "), held);
			if (text) paragraphs.push(currentIsItem ? asSentence(text) : text);
		}
		current = [];
		currentIsItem = false;
	};
	const lines = work.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.replace(/^\s*(?:>\s?)+/, "");
		if (line.trim() === "") {
			flush();
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("|") && TABLE_SEPARATOR.test(lines[i + 1]!.replace(/^\s*(?:>\s?)+/, ""))) {
			flush();
			while (i + 1 < lines.length && lines[i + 1]!.includes("|")) i++;
			paragraphs.push(SPEECH_MARKERS.table);
			continue;
		}
		if (HORIZONTAL_RULE.test(line)) {
			flush();
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			const text = inlineText(heading[1]!, held);
			if (text) paragraphs.push(asSentence(text));
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			flush();
			current = [item[1]!.replace(TASK_BOX, "")];
			currentIsItem = true;
			continue;
		}
		current.push(line.trim());
	}
	flush();
	return paragraphs;
}

/** Sentence pieces of a paragraph, closing quotes/brackets kept with their sentence. */
function sentencesOf(paragraph: string): string[] {
	return paragraph.split(/(?<=[.!?…]["')\]]*)\s+/).filter((s) => s !== "");
}

/** Cut an over-long atom at the last space within `max` (hard cut if none). */
function cutAtWords(atom: string, max: number): [string, string] {
	const space = atom.lastIndexOf(" ", max);
	if (space <= 0) return [atom.slice(0, max), atom.slice(max)];
	return [atom.slice(0, space), atom.slice(space + 1)];
}

/**
 * Markdown → ordered speech chunks. Empty markdown → no chunks.
 * Paragraphs pack into a chunk while they fit; a paragraph that doesn't fit
 * packs sentence by sentence; a sentence longer than the limit splits at words.
 */
export function markdownToSpeechChunks(markdown: string): string[] {
	const chunks: string[] = [];
	let buffer = "";
	const limit = () => (chunks.length === 0 ? FIRST_CHUNK_MAX : CHUNK_MAX);
	const flush = () => {
		if (buffer) chunks.push(buffer);
		buffer = "";
	};
	const place = (atom: string) => {
		while (atom) {
			if (buffer === "") {
				if (atom.length <= limit()) {
					buffer = atom;
					return;
				}
				const [head, rest] = cutAtWords(atom, limit());
				chunks.push(head);
				atom = rest;
			} else if (buffer.length + 1 + atom.length <= limit()) {
				buffer += ` ${atom}`;
				return;
			} else {
				flush();
			}
		}
	};
	for (const paragraph of speechParagraphs(markdown)) {
		if (buffer !== "" && buffer.length + 1 + paragraph.length <= limit()) buffer += ` ${paragraph}`;
		else if (buffer === "" && paragraph.length <= limit()) buffer = paragraph;
		else for (const sentence of sentencesOf(paragraph)) place(sentence);
	}
	flush();
	return chunks;
}

/**
 * What the dock reads for a pending question (slice 11): the PROMPT only, never
 * the answer options (nor their descriptions), and never the quiz's explanation
 * or an explain's committed answer. The prompt is the question text plus the
 * `details` (QuestionData.context) the dock shows right under it: the schema
 * defines them as "extra context or instructions shown under the question", so
 * they are part of what the learner is asked to do. Every mode (single/multi
 * select, text) reads the same fields. Takes the dock's parsed shape, so a
 * QuestionData or ClientQuestion fits as is.
 */
export function questionPromptMarkdown(question: { question: string; context?: string }): string {
	return [question.question, question.context ?? ""].filter((part) => part.trim() !== "").join("\n\n");
}

/** The prompt of a question as speech chunks (see questionPromptMarkdown). */
export function questionPromptSpeech(question: { question: string; context?: string }): string[] {
	return markdownToSpeechChunks(questionPromptMarkdown(question));
}

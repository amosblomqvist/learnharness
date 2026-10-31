/** Shared Markdown/TeX boundaries for legacy delimiter compatibility and
 * display-only tool-content recovery. Source arguments are never rewritten. */
import {
	canParseTex, knownTexCommand, mapMathContent, numericPercentEscape, outsideTexComments,
	readContentSpans, recoverDocumentLayout, texRanges,
} from "./content-reader.ts";

const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};

/** Preserve the legacy list-continuation policy: indented display math
 * degrades to inline rather than disrupting list structure. Literal code
 * indentation is already protected by the shared reader. */
function indented(text: string, i: number): boolean {
	const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	return prefix.length > 0 && /^[ \t]+$/.test(prefix);
}
function blockPosition(text: string, i: number): boolean {
	return /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
}

/** micromark closes native single-dollar spans at escaped dollars too.
 * Replace an intended literal dollar with equivalent dollar-free TeX before
 * tokenization. Code, prose, unbalanced spans and display dollars stay raw. */
function replaceEscapedDollars(content: string): string {
	let out = "";
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\\" && content[i + 1] === "$" && !escaped(content, i)) {
			out += "\\text{\\textdollar}"; i++;
		} else out += content[i];
	}
	return out;
}

/** Read old \(...\)/\[...\] syntax without touching literal content or
 * reparsing native math as Markdown. Dollar authoring remains native. */
export function transformMathDelimiters(markdown: string): string {
	let offset = 0;
	return readContentSpans(markdown).map(span => {
		const start = offset; offset += span.raw.length;
		if (span.kind !== "math") return span.raw;
		if (span.open === "$") return "$" + replaceEscapedDollars(span.body) + span.close;
		if (span.open !== "\\(" && span.open !== "\\[") return span.raw;
		const body = span.body.trim();
		if (!body) return span.raw;
		if (span.open === "\\(") return `$$${body}$$`;
		if (indented(markdown, start)) return `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
		const before = blockPosition(markdown, start) ? "" : "\n\n";
		const end = start + span.raw.length;
		const after = end === markdown.length || markdown[end] === "\n" ? "" : "\n\n";
		return `${before}$$\n${body}\n$$${after}`;
	}).join("");
}

const textCommands = new Set(["text", "textrm", "textit", "textbf", "textsf", "texttt", "mbox"]);
const naturalText = /[^\p{ASCII}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}][\p{L}\p{M}\p{N}\u00a0 \t،؛؟,.!?…'’"«»()\-]*/gu;

/** Ranges whose contents are already in TeX text mode. */
function explicitTextRanges(source: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	const command = /\\([A-Za-z]+)\s*\{/g;
	for (let match; (match = command.exec(source));) {
		if (!textCommands.has(match[1]!)) continue;
		const start = command.lastIndex;
		let depth = 1, i = start;
		for (; i < source.length && depth > 0; i++) {
			if (source[i] === "\\") { i++; continue; }
			if (source[i] === "{") depth++;
			else if (source[i] === "}") depth--;
		}
		if (depth === 0) ranges.push({ start, end: i - 1 });
		command.lastIndex = Math.max(command.lastIndex, i);
	}
	return ranges;
}

/** Escape natural-language text before placing it in a TeX text argument. */
function escapeTextArgument(text: string): string {
	return text.replace(/[\\#$%&_{}]/g, char => `\\${char}`);
}

function wrapUnmarkedNaturalText(source: string): string {
	const protectedRanges = explicitTextRanges(source);
	let range = 0;
	return source.replace(naturalText, (text, offset: number) => {
		while (range < protectedRanges.length && protectedRanges[range]!.end <= offset) range++;
		if (protectedRanges[range] && offset >= protectedRanges[range]!.start && offset < protectedRanges[range]!.end) return text;
		return `\\text{${escapeTextArgument(text)}}`;
	});
}

/** Normalize generated natural-language text only inside math, and only when
 * the resulting TeX parses. Invalid blocks become escaped literal text before
 * Markdown parsing; prose, code, and valid Markdown boundaries stay intact. */
export function prepareMathForRendering(markdown: string): string {
	const entities: Record<string, string> = {
		"&": "&amp;", "<": "&lt;", ">": "&gt;", "\\": "&#92;", "$": "&#36;",
		"*": "&#42;", "_": "&#95;", "`": "&#96;", "[": "&#91;", "]": "&#93;",
		"|": "&#124;", "~": "&#126;", "#": "&#35;", "-": "&#45;", "+": "&#43;",
		"!": "&#33;", ".": "&#46;",
	};
	const literal = (source: string) => source.replace(/[&<>\\$*_`\[\]|~#+!.-]/g, char => entities[char] ?? char);
	return readContentSpans(markdown).map(span => {
		if (span.kind !== "math") return span.raw;
		const candidate = outsideTexComments(span.body, wrapUnmarkedNaturalText);
		if (candidate !== span.body && canParseTex(candidate, span.display)) return span.open + candidate + span.close;
		return canParseTex(span.body, span.display) ? span.raw : literal(span.raw);
	}).join("");
}

const DEBRIS: Record<string, string> = {
	"\b": "\\b", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\r": "\\r",
};

/** Recover JSON-swallowed command prefixes only in recognized math, never
 * in code or genuine TeX comments. Restore all debris in one pass. Physical
 * display newlines and CRLF remain source whitespace. Inline LF recovery is
 * limited to complete known n-command names. Under the approved typical-
 * model-authoring policy this includes newline+u→nu in inline math only;
 * already-correct commands are never decoded into whitespace. */
export function restoreMathEscapes(text: string): string {
	if (!/[\b\t\n\v\f\r]/.test(text)) return text;
	return mapMathContent(text, (body, display) => outsideTexComments(body, part => {
		const restored = part.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
			if (char === "\r" && part[offset + 1] === "\n") return char;
			const suffix = /^[A-Za-z]+/.exec(part.slice(offset + 1))?.[0];
			return suffix && knownTexCommand(DEBRIS[char]!.slice(1) + suffix) ? DEBRIS[char]! : char;
		});
		if (display) return restored;
		return restored.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
			knownTexCommand("n" + suffix) ? "\\n" + suffix : whole);
	}));
}

const commandSymbol = /[,;:!|{}%]/;

/** Decode prefixes and row separators according to ORIGINAL TeX context.
 * A native pair is literal; an encoded pair supplies a factor, so an encoded
 * four-backslash row becomes TWO, never a command prefix. Unknown commands
 * without that structural evidence are left alone. */
function recoverCommandRuns(inner: string, display: boolean): string {
	const ranges = texRanges(inner);
	const recovered = inner.replace(/\\+/g, (run: string, offset: number) => {
		const contexts = ranges.filter(r => offset >= r.start && offset < r.end);
		if (contexts.some(r => r.kind === "row" || r.kind === "comment") || run.length % 2 !== 0) return run;
		const next = inner[offset + run.length] ?? "";
		const encoded = contexts.filter(r => r.kind === "encoded").at(-1);
		const word = /^[A-Za-z]+/.exec(inner.slice(offset + run.length))?.[0];
		if (encoded) {
			const factor = encoded.factor!;
			const rows = run.length % (2 * factor) === 0;
			const command = word ? knownTexCommand(word) : commandSymbol.test(next);
			if (run.length % factor === 0 && (rows || command)) return "\\".repeat(run.length / factor);
			return run;
		}
		if (next === "%") return numericPercentEscape(inner, offset + run.length) ? "\\" : run;
		if (word) return word.length > 1 && knownTexCommand(word) ? "\\" : run;
		return next && commandSymbol.test(next) ? "\\" : run;
	});
	// Structural evidence is primary (parse success cannot prove row
	// preservation). As an additional guard, never turn parseable source into
	// a parse failure through partial command recovery.
	if (recovered !== inner && !canParseTex(recovered, display) && canParseTex(inner, display)) return inner;
	return recovered;
}

export function healOverescapedCommands(text: string): string {
	return text.includes("\\\\") ? mapMathContent(text, recoverCommandRuns) : text;
}

/** Presentation-only, language-independent recovery. Shape parsing, saved
 * identities, grading and model history must use the unprojected source. */
export function repairMathForDisplay(text: string): string {
	return healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)));
}

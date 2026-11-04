/** Source-preserving boundaries for tool-authored Markdown. Recovery never
 * mutates input, reserializes Markdown, or enters protected literal content. */
import katex from "katex";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";

export type ContentSpan =
	| { kind: "prose" | "code"; raw: string }
	| { kind: "math"; raw: string; open: string; body: string; close: string; display: boolean };
const blankLine = /^\r?\n[ \t]*\r?\n/;
const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};
const runLength = (text: string, i: number, char: string) => { let n = 0; while (text[i + n] === char) n++; return n; };
type MarkdownNode = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MarkdownNode[] };
/** Use the rendering stack's actual CommonMark+math grammar for literal
 * ranges, including nested quotes/lists and implicit container endings.
 * Keep source offsets: never serialize the AST back into Markdown. */
function literalRanges(text: string): Array<{ start: number; end: number }> {
	const pending: MarkdownNode[] = [fromMarkdown(text, { extensions: [math({ singleDollarTextMath: true })], mdastExtensions: [mathFromMarkdown()] })];
	const ranges: Array<{ start: number; end: number }> = [];
	while (pending.length) {
		const node = pending.pop()!;
		if (node.type === "code" || node.type === "inlineCode") {
			const start = node.position?.start.offset, end = node.position?.end.offset;
			if (start !== undefined && end !== undefined) ranges.push({ start, end });
		} else if (node.children) pending.push(...node.children);
	}
	return ranges.sort((a, b) => a.start - b.start);
}

/** Mirrors the app's native dollar-run and legacy-delimiter conventions,
 * with code and blank paragraphs as inline boundaries. */
export function readContentSpans(text: string): ContentSpan[] {
	const spans: ContentSpan[] = [];
	const literals = literalRanges(text);
	let literal = 0, i = 0, plain = 0;
	const opaque = (end: number) => {
		if (plain < i) spans.push({ kind: "prose", raw: text.slice(plain, i) });
		spans.push({ kind: "code", raw: text.slice(i, end) }); i = plain = end;
	};
	while (i < text.length) {
		while (literal < literals.length && literals[literal]!.end <= i) literal++;
		const barrier = literals[literal]?.start ?? Infinity;
		if (i >= barrier) { opaque(literals[literal]!.end); continue; }
		let open = "", close = "", display = false, after = -1, at = -1;
		if (text[i] === "\\" && !escaped(text, i) && ["(", "["].includes(text[i + 1] ?? "")) {
			open = text.slice(i, i + 2); close = open === "\\(" ? "\\)" : "\\]"; display = open === "\\[";
			for (let j = i + 2; j < text.length - 1; j++) {
				if (j >= barrier || (!display && blankLine.test(text.slice(j)))) break;
				if (text.startsWith(close, j) && !escaped(text, j)) { at = j; after = j + 2; break; }
			}
		} else if (text[i] === "$" && !escaped(text, i)) {
			const size = runLength(text, i, "$"); open = "$".repeat(size);
			const eol = text.indexOf("\n", i + size);
			const before = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
			display = size >= 2 && /^[ \t]{0,3}$/.test(before) && !text.slice(i + size, eol < 0 ? text.length : eol).includes("$");
			if (display) {
				let start = eol;
				while (start >= 0 && start < text.length) {
					start++;
					const next = text.indexOf("\n", start);
					const match = /^([ \t]{0,3})(\$+)[ \t]*\r?$/.exec(text.slice(start, next < 0 ? text.length : next));
					if (match && match[2]!.length >= size) { at = start + match[1]!.length; close = match[2]!; after = at + close.length; break; }
					start = next;
				}
			} else {
				for (let j = i + size; j < text.length;) {
					if (j >= barrier || blankLine.test(text.slice(j))) break;
					if (text[j] === "$" && !escaped(text, j)) {
						const n = runLength(text, j, "$");
						if (n === size) { at = j; close = open; after = j + n; break; }
						j += n;
					} else j++;
				}
			}
		}
		if (at >= 0) {
			if (plain < i) spans.push({ kind: "prose", raw: text.slice(plain, i) });
			spans.push({ kind: "math", raw: text.slice(i, after), open, body: text.slice(i + open.length, at), close, display });
			i = plain = after;
		} else i += open.length || 1;
	}
	if (plain < text.length) spans.push({ kind: "prose", raw: text.slice(plain) });
	return spans;
}

export function mapMathContent(text: string, transform: (body: string, display: boolean) => string): string {
	return readContentSpans(text).map(span => span.kind === "math" ? span.open + transform(span.body, span.display) + span.close : span.raw).join("");
}

const knownCommands = new Map<string, boolean>();
/** Probe only a command name, never arbitrary content. Missing-argument errors
 * still identify a known command. No trust, macros, IO, or persistent TeX state. */
export function knownTexCommand(name: string): boolean {
	if (!/^[A-Za-z]+$/.test(name)) return false;
	const cached = knownCommands.get(name); if (cached !== undefined) return cached;
	let known = true;
	try { katex.renderToString("\\" + name, { throwOnError: true, trust: false, strict: false }); }
	catch (error) { known = !String(error).includes("Undefined control sequence: \\" + name); }
	knownCommands.set(name, known);
	return known;
}

export function canParseTex(body: string, display: boolean): boolean {
	try { katex.renderToString(body, { throwOnError: true, trust: false, strict: false, displayMode: display }); return true; }
	catch { return false; }
}

export interface TexRange { start: number; end: number; kind: "row" | "encoded" | "comment"; factor?: number }
export function numericPercentEscape(inner: string, percent: number): boolean {
	let start = percent; while (start > 0 && inner[start - 1] === "\\") start--;
	if (percent - start < 2 || (percent - start) % 2 !== 0 || !/\d[ \t]*$/.test(inner.slice(0, start))) return false;
	const tail = inner.slice(percent + 1);
	// A final source-formatting LF before the closing fence is not a next
	// equation row. A meaningful following line or comment text remains literal.
	if (/^[\s.)\]}]*$/.test(tail)) return true;
	return !/[\r\n]/.test(tail) && !/^[ \t]*[A-Za-z]/.test(tail);
}

/** TeX boundaries shared by document decoding and command recovery. Native
 * rows are literal; consistently extra-escaped environment pairs supply an
 * explicit escaping factor for both commands AND row separators. */
export function texRanges(inner: string): TexRange[] {
	const ranges: TexRange[] = [];
	const stack: Array<{ name: string; start: number; factor: number }> = [];
	let i = 0;
	while (i < inner.length) {
		if (inner[i] === "%" && !escaped(inner, i)) {
			let start = i; while (start > 0 && inner[start - 1] === "\\") start--;
			const factor = stack.at(-1)?.factor ?? ranges.filter(r => r.kind === "encoded" && i >= r.start && i < r.end).at(-1)?.factor;
			const encodedLiteral = factor && factor > 1 && (i - start) % factor === 0 && ((i - start) / factor) % 2 === 1;
			const native = stack.some(frame => frame.factor === 1) || ranges.some(r => r.kind === "row" && i >= r.start && i < r.end);
			if (encodedLiteral || (!native && numericPercentEscape(inner, i))) { i++; continue; }
			const newline = inner.indexOf("\n", i);
			const end = newline < 0 ? inner.length : newline + 1;
			ranges.push({ start: i, end, kind: "comment" }); i = end; continue;
		}
		if (inner[i] !== "\\") { i++; continue; }
		let end = i + 1; while (inner[end] === "\\") end++;
		const count = end - i;
		const marker = /^(begin|end)\s*\{([^{}]+)\}/.exec(inner.slice(end));
		if (marker) {
			const factor = count % 2 === 1 ? 1 : count;
			if (marker[1] === "begin") stack.push({ name: marker[2]!, start: i, factor });
			else if (stack.at(-1)?.name === marker[2] && stack.at(-1)?.factor === factor) {
				const open = stack.pop()!;
				ranges.push({ start: open.start, end: end + marker[0].length, kind: factor === 1 ? "row" : "encoded", factor });
			}
			i = end + marker[0].length; continue;
		}
		// KaTeX's substack macro expands its braced argument into subarray:
		// these are row separators even without literal begin/end markers.
		const substack = /^substack\s*\{/.exec(inner.slice(end));
		if (substack) {
			let depth = 1, j = end + substack[0].length;
			for (; j < inner.length && depth > 0; j++) {
				if (inner[j] === "%" && !escaped(inner, j)) { const lf = inner.indexOf("\n", j); j = lf < 0 ? inner.length : lf; continue; }
				if (!escaped(inner, j)) { if (inner[j] === "{") depth++; else if (inner[j] === "}") depth--; }
			}
			if (depth === 0) ranges.push({ start: i, end: j, kind: count % 2 === 1 ? "row" : "encoded", factor: count % 2 === 1 ? 1 : count });
		}
		i = end;
	}
	return ranges.sort((a, b) => a.start - b.start);
}

export function outsideTexComments(body: string, transform: (part: string) => string): string {
	let from = 0; const out: string[] = [];
	for (const range of texRanges(body).filter(r => r.kind === "comment")) {
		out.push(transform(body.slice(from, range.start)), body.slice(range.start, range.end)); from = range.end;
	}
	out.push(transform(body.slice(from))); return out.join("");
}

/** Document escapes are not arbitrary string decoding. Complete known TeX
 * words win over the prefix `\\n`; code is never inspected or rewritten. */
export function recoverDocumentLayout(text: string): string {
	const spans = readContentSpans(text);
	const candidates = spans.filter(span => span.kind !== "code").map(span => span.raw).join("\u0000");
	const declared = new Set([
		...candidates.matchAll(/\\(?:newcommand|renewcommand|providecommand)\*?\s*(?:\{\s*)?\\(n[A-Za-z]+)/g),
		...candidates.matchAll(/\\(?:def|gdef|edef)\s*\\(n[A-Za-z]+)/g),
	].map(m => m[1]!));
	const knownN = (name: string) => declared.has(name) || knownTexCommand(name);
	const tokens = [...candidates.matchAll(/(\\+)(n[A-Za-z]*)/g)];
	const evidence = tokens.filter(m => m[1]!.length % 2 === 1 && !knownN(m[2]!));
	const structural = evidence.length >= 2 || candidates.includes("\\n\\n") || (evidence.length > 0 &&
		[...candidates.matchAll(/(\\+)([A-Za-z]+)/g)].some(m => m[1]!.length % 2 === 0 && knownTexCommand(m[2]!)));
	if (!structural) return text;
	const decode = (part: string) => part.replace(/(\\+)(n[A-Za-z]*)/g, (whole: string, slashes: string, name: string, offset: number) => {
		if (slashes.length % 2 === 0 || knownN(name)) return whole;
		const word = part.slice(0, offset).split(/\s/).at(-1) ?? "";
		if (/^(?:[A-Za-z]:[\\/]|https?:\/\/|\/)/.test(word + whole)) return whole;
		return slashes.slice(0, -1) + "\n" + name.slice(1);
	});
	const projected = spans.map(span => ({ span, body: span.kind === "math" ? outsideTexComments(span.body, decode) : span.kind === "code" ? span.raw : decode(span.raw) }));
	let out = "";
	for (let i = 0; i < projected.length; i++) {
		const { span, body } = projected[i]!;
		if (span.kind !== "math") { out += body; continue; }
		// Decoding document layout can expose a flow opener whose close was
		// written on the formula line. Frame BOTH ends; otherwise Markdown
		// consumes the closing dollars as TeX and introduces a rendering error.
		if (/^\${2,}$/.test(span.open) && body !== span.body && body.includes("\n")) {
			if (!/^[ \t]{0,3}$/.test(out.slice(out.lastIndexOf("\n") + 1))) out += "\n\n";
			out += span.open + (body.startsWith("\n") ? "" : "\n") + body + (body.endsWith("\n") ? "" : "\n") + span.close;
			const next = projected[i + 1];
			if (next && !/^[\r\n]/.test(next.span.kind === "math" ? next.span.open : next.body)) out += "\n\n";
		} else out += span.open + body + span.close;
	}
	return out;
}

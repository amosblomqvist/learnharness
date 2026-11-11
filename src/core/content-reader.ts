/** Source-preserving boundaries for tool-authored Markdown. Recovery never
 * mutates input or reserializes Markdown. Native literals are protected;
 * standalone extra-encoded fences have one explicit display-only recovery. */
import katex from "katex";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";

export type ContentSpan =
	| { kind: "prose"; raw: string }
	| { kind: "code"; raw: string; escapedFence?: true }
	| { kind: "math"; raw: string; open: string; body: string; close: string; display: boolean };
const blankLine = /^\r?\n[ \t]*\r?\n/;
const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};
const runLength = (text: string, i: number, char: string) => { let n = 0; while (text[i + n] === char) n++; return n; };
type MarkdownNode = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MarkdownNode[] };
type LiteralRange = { start: number; end: number; escapedFence?: true };

/** Read virtual lines without decoding their contents. Only odd final slashes
 * denote layout; even runs before n remain literal source. */
function escapedFenceRanges(text: string, native: LiteralRange[]): { fences: LiteralRange[]; native: LiteralRange[] } {
	if (!text.includes("\\n") || !/`{3,}|~{3,}/.test(text)) return { fences: [], native };
	const lines: Array<{ start: number; end: number }> = [];
	let start = 0;
	for (const match of text.matchAll(/\r\n?|\n|(\\+)(r\\n|n)?/g)) {
		if (match[1] && (!match[2] || match[1].length % 2 === 0)) continue;
		const boundary = match.index + (match[1] ? match[1].length - 1 : 0);
		lines.push({ start, end: boundary });
		start = match.index + match[0].length;
	}
	lines.push({ start, end: text.length });
	const ranges: LiteralRange[] = [];
	const protect = (start: number, end: number, complete: boolean) => {
		const fenceStart = start + /^ {0,3}/.exec(text.slice(start, start + 3))![0].length;
		// Preserve enclosing native literals, including a native opener at
		// this same offset. Backticks INSIDE the virtual fence are code, not
		// independent inline ranges that can expose its body to layout repair.
		if (!native.some(literal => literal.start <= fenceStart && literal.end > start &&
			(literal.start < start || literal.end > end))) {
			ranges.push({ start, end, ...(complete ? { escapedFence: true as const } : {}) });
			if (native.some(literal => literal.start >= start && literal.start < end && literal.end > end)) {
				// An internal backtick may have paired with a suffix backtick.
				// Re-read that independent suffix with the SAME grammar and map
				// its source offsets back, before scanning any later fences.
				native = [...native.filter(literal => literal.start < start), ...nativeLiteralRanges(text.slice(end), end)];
			}
		}
	};
	let opening: { start: number; fence: string } | undefined;
	for (const line of lines) {
		const value = text.slice(line.start, line.end);
		if (!opening) {
			const match = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(value);
			if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) continue;
			// Never enter an outer native fence or inline literal example. An
			// inline-code range beginning HERE may be the escaped fence itself.
			if (native.some(range => range.start < line.start && range.end > line.start)) continue;
			opening = { start: line.start, fence: match[1]! };
			continue;
		}
		const close = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(value)?.[1];
		if (!close || close[0] !== opening.fence[0] || close.length < opening.fence.length) continue;
		protect(opening.start, line.end, true);
		opening = undefined;
	}
	// Rejected profiles must be opaque to the generic layout decoder too:
	// physical openers may have encoded bodies, and an unfinished fence
	// protects the remainder just like an unfinished native Markdown fence.
	if (opening) protect(opening.start, text.length, false);
	return { fences: ranges, native };
}

/** Use the rendering stack's actual CommonMark+math grammar for literal
 * ranges, including nested quotes/lists and implicit container endings.
 * Keep source offsets: never serialize the AST back into Markdown. */
function nativeLiteralRanges(text: string, offset = 0): LiteralRange[] {
	const pending: MarkdownNode[] = [fromMarkdown(text, { extensions: [math({ singleDollarTextMath: true })], mdastExtensions: [mathFromMarkdown()] })];
	const ranges: LiteralRange[] = [];
	while (pending.length) {
		const node = pending.pop()!;
		if (node.type === "code" || node.type === "inlineCode") {
			const start = node.position?.start.offset, end = node.position?.end.offset;
			if (start !== undefined && end !== undefined) ranges.push({ start: start + offset, end: end + offset });
		} else if (node.children) pending.push(...node.children);
	}
	return ranges;
}

function literalRanges(text: string): LiteralRange[] {
	const { fences, native } = escapedFenceRanges(text, nativeLiteralRanges(text));
	// Native inline ranges/openers starting INSIDE a virtual code section
	// cannot extend beyond its close and swallow following prose either.
	return [...native.filter(range => !fences.some(fence => fence.start <= range.start && range.start < fence.end)), ...fences]
		.sort((a, b) => a.start - b.start);
}

/** Mirrors the app's native dollar-run and legacy-delimiter conventions,
 * with code and blank paragraphs as inline boundaries. */
export function readContentSpans(text: string): ContentSpan[] {
	const spans: ContentSpan[] = [];
	const literals = literalRanges(text);
	let literal = 0, i = 0, plain = 0;
	const opaque = ({ end, escapedFence }: LiteralRange) => {
		if (plain < i) spans.push({ kind: "prose", raw: text.slice(plain, i) });
		spans.push({ kind: "code", raw: text.slice(i, end), ...(escapedFence ? { escapedFence } : {}) }); i = plain = end;
	};
	while (i < text.length) {
		while (literal < literals.length && literals[literal]!.end <= i) literal++;
		const barrier = literals[literal]?.start ?? Infinity;
		if (i >= barrier) { opaque(literals[literal]!); continue; }
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

/** One extra JSON-string layer, local to a complete standalone fence. The
 * layer-aware idea is from joneskim's PR #67; unlike its historical parser
 * placement this is display-only. Never replace individual code escapes.
 * A valid profile is structural evidence, NOT proof of the author's intent. */
function decodeEscapedCodeFence(raw: string): string | null {
	if (/[\r\n]/.test(raw)) return null; // mixed physical/encoded layout
	let decoded: string;
	try { decoded = JSON.parse(`"${raw}"`) as string; } catch { return null; }
	const lines = decoded.split(/\r?\n/);
	if (lines.length < 2) return null;
	const open = /^[ ]{0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
	const close = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1)!)?.[1];
	if (!open || !close || close[0] !== open[0] || close.length < open.length) return null;
	// Use the actual CommonMark grammar to reject early closes, extra blocks
	// and invalid info strings. Keep decoded source, never AST serialization.
	const tree = fromMarkdown(decoded);
	return tree.children.length === 1 && tree.children[0]?.type === "code" ? decoded : null;
}

/** Document escapes are not arbitrary string decoding. Complete known TeX
 * words win over the prefix `\\n`; native code is never rewritten. */
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
	const recoveredFences = new Map(spans.flatMap(span => {
		if (span.kind !== "code" || !span.escapedFence) return [];
		const decoded = decodeEscapedCodeFence(span.raw);
		return decoded === null ? [] : [[span, decoded] as const];
	}));
	const hasEscapedFence = recoveredFences.size > 0;
	const structural = hasEscapedFence || evidence.length >= 2 || candidates.includes("\\n\\n") || (evidence.length > 0 &&
		[...candidates.matchAll(/(\\+)([A-Za-z]+)/g)].some(m => m[1]!.length % 2 === 0 && knownTexCommand(m[2]!)));
	if (!structural) return text;
	const decode = (part: string) => part.replace(/(\\+)(n[A-Za-z]*)/g, (whole: string, slashes: string, name: string, offset: number) => {
		if (slashes.length % 2 === 0 || knownN(name)) return whole;
		const word = part.slice(0, offset).split(/\s/).at(-1) ?? "";
		if (/^(?:[A-Za-z]:[\\/]|https?:\/\/|\/)/.test(word + whole)) return whole;
		return slashes.slice(0, -1) + "\n" + name.slice(1);
	});
	const projected = spans.map(span => ({
		span,
		body: span.kind === "math"
			? outsideTexComments(span.body, decode)
			: span.kind === "code"
				? (recoveredFences.get(span) ?? span.raw)
				: decode(span.raw),
	}));
	let out = "";
	for (let i = 0; i < projected.length; i++) {
		const { span, body } = projected[i]!;
		if (span.kind === "code" && body !== span.raw) {
			if (!/^[ \t]{0,3}$/.test(out.slice(out.lastIndexOf("\n") + 1))) out += "\n\n";
			out += body;
			const next = projected[i + 1];
			if (next && !/^[\r\n]/.test(next.span.kind === "math" ? next.span.open : next.body)) out += "\n\n";
			continue;
		}
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

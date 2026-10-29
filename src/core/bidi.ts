/** Content direction and literal LTR isolation, independent of the page direction. */
// Letters in the blocks Unicode assigns right-to-left by default (Bidi_Class R or AL): Hebrew, Arabic, Syriac,
// Thaana, NKo and their supplements, the presentation forms, and the historic and future RTL scripts
// (U+10800-10FFF, U+1E800-1EFFF). Tatweel (U+0640) is AL but stays neutral, see NEUTRAL_EXTENDERS.
const RTL_LETTER = /(?=\p{Letter})(?!\u0640)[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const NEUTRAL_EXTENDERS = ["ـ"];
// Shaping extenders remain neutral despite their Unicode letter category.
const LETTER = new RegExp(`(?![${NEUTRAL_EXTENDERS.join("")}])\\p{Letter}`, "u");
const LTR_LETTER_SOURCE = `(?!${RTL_LETTER.source}|[${NEUTRAL_EXTENDERS.join("")}])\\p{Letter}`;
// What ends a run is what the browser reads as strong right-to-left: a right-to-left letter, an Arabic-script
// digit, the Arabic and Hebrew punctuation of Bidi_Class AL or R, a right-to-left mark; and a line break, which
// `.` never matches. Everything else between two left-to-right pieces stays in the run (`1,000`, `Hello, world`,
// `f(x, y)`, `a@b.com`), as a neutral between two left-to-right characters takes their direction (UAX #9 N1).
const RTL_STRONG_SOURCE = `${RTL_LETTER.source}|[\\u0660-\\u0669\\u06F0-\\u06F9\\u061B\\u061C\\u061F\\u05BE\\u05C0\\u05C3\\u05C6\\u200F]`;
const RTL_STRONG = new RegExp(RTL_STRONG_SOURCE, "u");
const RUN_CHUNK = new RegExp(`(?:(?!${RTL_STRONG_SOURCE}).)+`, "gu");
// A run opens with a letter or digit, or a sign or dot glued to one (`-5`, `$100`, `/usr/bin`, `.NET`, `#tag`),
// unless the sign is glued to a word before it too (the Hebrew prefix in `ל-Python` keeps its hyphen).
const SIGNS = "-+−$€£#./";
const RUN_START = new RegExp(`^[${SIGNS}]?(?:${LTR_LETTER_SOURCE}|[0-9])`, "u");
const WORD_END = /(?:\p{Letter}|\p{Nd})$/u;
// A run ends with a letter or digit, a symbol glued to it (`C++`, `50%`, `x²`), a closing bracket or quote,
// or a combining mark (an accent stays with its letter). Sentence punctuation stays out.
const RUN_END = new RegExp(`(?:${LTR_LETTER_SOURCE}|[0-9+#%'’"”)\\]}\\p{M}\\p{No}])$`, "u");
const OPEN_QUOTES = "'‘\"“";
const CLOSE_QUOTES = "'’\"”";
// A URL runs from its scheme (or `www.`) to the next whitespace, right-to-left letters
// included, so an Arabic path segment stays in it. It starts at the beginning of a
// token, so a long word is scanned once.
const URL_START = /(?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:)\S+/giu;
const URL_TRAILING = /[.,;:!?،؛؟'"”’»>]/u;
// Math delimiters, escapes and backtick runs. A backslash before a backtick is no token: outside code it escapes
// the backtick, inside code it is a character, and only the pairing below knows which.
const DELIMITERS = /\\[()[\]]|\\[^`]|`+|\$+/g;
const OPEN_BRACKETS = "([{";
const CLOSE_BRACKETS = ")]}";

export interface BidiSegment {
	text: string;
	ltr: boolean;
}

export function hasRtlLetter(text: string): boolean {
	return RTL_LETTER.test(text);
}

/** The direction of the letters in text that is already prose: any right-to-left
 * letter gives "rtl", else any letter "ltr", else `undefined` (inherit). Nothing
 * is parsed, so a literal `$` or backtick is just a character. Not the
 * first-strong rule (UAX #9 P2): an Arabic sentence often opens with an English
 * term (`Newton ينص...`), and any right-to-left letter marks the line as
 * right-to-left prose. */
export function letterDirection(text: string): "rtl" | "ltr" | undefined {
	return hasRtlLetter(text) ? "rtl" : LETTER.test(text) ? "ltr" : undefined;
}

/** `letterDirection` for prose that may hold URLs: a URL is one left-to-right
 * unit whatever its path holds, so its letters do not count (`See
 * https://ar.wikipedia.org/wiki/فيزياء for details.` is English). The blocks and
 * the plain-text surfaces read this; `letterDirection` stays the cheap rule for
 * labels drawn every frame. */
export function proseDirection(text: string): "rtl" | "ltr" | undefined {
	return letterDirection(maskUrls(text));
}

/** For raw Markdown source: ignore balanced math and code, then take the letter direction. */
export function textDirection(text: string): "rtl" | "ltr" | undefined {
	const tokens = Array.from(text.matchAll(DELIMITERS));
	const next = new Map<string, number>();
	const closes: Array<number | undefined> = [];
	// Index matching delimiters once so incomplete spans never cause rescanning.
	for (let i = tokens.length - 1; i >= 0; i--) {
		const token = tokens[i]![0];
		const close = token === "\\(" ? "\\)" : token === "\\[" ? "\\]" : token;
		closes[i] = next.get(close);
		next.set(token, i);
	}
	const prose: string[] = [];
	let from = 0;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const marker = token[0];
		if (!(marker[0] === "`" || marker === "$" || marker === "$$" || marker === "\\(" || marker === "\\[")) continue;
		// A backslash right before a backtick run is an escape unless it is itself escaped (the `\\` token
		// ends where the run starts): the run is then literal text and opens nothing.
		const previous = tokens[i - 1];
		if (marker[0] === "`" && text[token.index - 1] === "\\" && !(previous !== undefined && previous.index + previous[0].length === token.index)) continue;
		const closing = closes[i];
		if (closing === undefined) continue;
		prose.push(text.slice(from, token.index));
		const end = tokens[closing]!;
		from = end.index + end[0].length;
		i = closing;
	}
	prose.push(text.slice(from));
	return letterDirection(prose.join(""));
}

/** Map both ends of each balanced bracket pair within one candidate run. */
function bracketPairs(text: string, start: number, end: number): Map<number, number> {
	const openings: number[] = [];
	const pairs = new Map<number, number>();
	for (let i = start; i < end; i++) {
		const ch = text[i]!;
		if (OPEN_BRACKETS.includes(ch)) openings.push(i);
		else if (CLOSE_BRACKETS.includes(ch)) {
			const opening = openings[openings.length - 1];
			if (opening !== undefined && OPEN_BRACKETS.indexOf(text[opening]!) === CLOSE_BRACKETS.indexOf(ch)) {
				openings.pop();
				pairs.set(opening, i);
				pairs.set(i, opening);
			} else openings.length = 0; // A mismatched bracket splits the run.
		}
	}
	return pairs;
}

/** The same text with every URL turned into letters of the same length, so the
 * run scan keeps `https://example.com/a?x=1&y=2` whole. Trailing sentence
 * punctuation and a closing bracket the URL did not open stay out of it. */
function maskUrls(text: string): string {
	return text.replace(URL_START, (url) => {
		// Each bracket is counted once; a trimmed closing bracket leaves the count.
		const opens = [0, 0, 0];
		const closes = [0, 0, 0];
		for (const ch of url) {
			const open = OPEN_BRACKETS.indexOf(ch);
			const close = CLOSE_BRACKETS.indexOf(ch);
			if (open >= 0) opens[open] = (opens[open] ?? 0) + 1;
			else if (close >= 0) closes[close] = (closes[close] ?? 0) + 1;
		}
		let end = url.length;
		for (;;) {
			const last = url[end - 1]!;
			const close = CLOSE_BRACKETS.indexOf(last);
			if (!URL_TRAILING.test(last) && !(close >= 0 && (opens[close] ?? 0) < (closes[close] ?? 0))) break;
			if (close >= 0) closes[close] = (closes[close] ?? 0) - 1;
			end--;
		}
		return "a".repeat(end) + url.slice(end);
	});
}

/** Preserve every input character; unmatched brackets and sentence punctuation
 * remain outside LTR runs. Balanced opening brackets travel with their run. */
export function ltrRuns(text: string): BidiSegment[] {
	const scan = maskUrls(text);
	const segments: BidiSegment[] = [];
	const push = (start: number, end: number, ltr: boolean): void => {
		if (start === end) return;
		segments.push({ text: text.slice(start, end), ltr });
	};
	let from = 0;
	for (const chunk of scan.matchAll(RUN_CHUNK)) {
		const start = chunk.index;
		const end = start + chunk[0].length;
		const pairs = bracketPairs(scan, start, end);
		let piece = start;
		for (let boundary = start; boundary <= end; boundary++) {
			const ch = scan[boundary] ?? "";
			if (boundary < end && (!"()[]{}".includes(ch) || pairs.has(boundary))) continue;
			let left = piece;
			let right = boundary;
			// Inspect up to three UTF-16 units: a glued sign, then a letter that may be a surrogate pair.
			while (left < right && !RUN_START.test(scan.slice(left, left + 3))) left++;
			if (left < right && SIGNS.includes(scan[left]!) && WORD_END.test(scan.slice(Math.max(0, left - 2), left))) left++;
			if (left < right) {
				// Include balanced wrappers, even when they contain leading spaces.
				for (let opening = piece; opening < left; opening++) {
					if ((pairs.get(opening) ?? -1) >= left) {
						left = opening;
						break;
					}
				}
				while (right > left && !RUN_END.test(scan.slice(Math.max(left, right - 2), right))) right--;
				// A closing quote at the run end takes the opening quote just before the run, as a bracket pair is kept.
				const quote = CLOSE_QUOTES.indexOf(scan[right - 1]!);
				if (quote >= 0 && left > piece && scan[left - 1] === OPEN_QUOTES[quote]) left--;
				push(from, left, false);
				push(left, right, true);
				from = right;
			}
			piece = boundary + 1;
		}
	}
	push(from, text.length, false);
	return segments;
}

/** The text with each left-to-right run wrapped in an isolate (U+2066 LRI … U+2069
 * PDI), for text drawn without markup (a canvas label, an SVG title): `تعلم C++`
 * then draws `C++` the way the chat shows it, not `++C`. The isolates have no width. */
export function isolateLtrRuns(text: string): string {
	return ltrRuns(text).map((run) => (run.ltr ? `\u2066${run.text}\u2069` : run.text)).join("");
}

/** What a part that is not text adds to the run scan: code and math read as one
 * left-to-right letter, and a break (line, list item, cell, nested block) ends every run. */
export const LITERAL_TEXT = "a";
export const BREAK_TEXT = "\n";

/** One piece of a block's inline content, as the text it adds to the block. An
 * atomic part (an inline element, code or math) is never split. */
export interface InlinePart {
	text: string;
	atomic: boolean;
}

/** The characters `[from, to)` of one part. */
export interface PartSlice {
	part: number;
	from: number;
	to: number;
}

/** Consecutive slices that form one left-to-right phrase (`ltr`), or none. */
export interface Phrase {
	ltr: boolean;
	slices: PartSlice[];
}

/** `ltrRuns` over the whole text of a block instead of one string, so a phrase is
 * found across inline markup (`Newton's **second law**`, `**C**++`,
 * `(**derivative**)`), then mapped back onto the parts: text parts split at the
 * run boundaries, and an atomic part joins a run only when it lies inside it. A
 * run that an atomic part sticks out of extends over the whole part when the
 * part holds no strong right-to-left character, the ones that end a run
 * (`Newton [law.](…)` is one phrase, link included); when it holds one, the run
 * is not isolated here and the part is handled as a context of its own. */
export function ltrPhrases(parts: readonly InlinePart[]): Phrase[] {
	const spans: Array<{ start: number; end: number }> = [];
	let length = 0;
	for (const part of parts) {
		spans.push({ start: length, end: length + part.text.length });
		length += part.text.length;
	}
	// An empty part sits inside a run only strictly between its two ends.
	const inside = (run: { start: number; end: number }, span: { start: number; end: number }): boolean =>
		span.start === span.end ? run.start < span.start && span.start < run.end : run.start <= span.start && span.end <= run.end;
	const runs: Array<{ start: number; end: number }> = [];
	let at = 0;
	// The parts and the runs are both in text order, so each is walked once: a part that ends before a run
	// begins never meets a later run.
	let first = 0;
	for (const run of ltrRuns(parts.map((part) => part.text).join(""))) {
		const range = { start: at, end: at + run.text.length };
		at = range.end;
		if (!run.ltr) continue;
		while (first < parts.length && spans[first]!.end <= range.start) first++;
		let own = false;
		for (let index = first; index < parts.length && spans[index]!.start < range.end; index++) {
			const span = spans[index]!;
			if (!parts[index]!.atomic || span.start === span.end || inside(range, span)) continue;
			if (RTL_STRONG.test(parts[index]!.text)) {
				own = true;
				break;
			}
			range.start = Math.min(range.start, span.start);
			range.end = Math.max(range.end, span.end);
		}
		if (own) continue;
		const last = runs[runs.length - 1];
		if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else runs.push(range);
	}
	const phrases: Phrase[] = [];
	let current = -2;
	const place = (run: number, slice: PartSlice): void => {
		if (run !== current) {
			phrases.push({ ltr: run >= 0, slices: [] });
			current = run;
		}
		phrases[phrases.length - 1]!.slices.push(slice);
	};
	let run = 0;
	parts.forEach((part, index) => {
		const span = spans[index]!;
		if (part.atomic) {
			while (run < runs.length && runs[run]!.end <= span.start) run++;
			place(run < runs.length && inside(runs[run]!, span) ? run : -1, { part: index, from: 0, to: part.text.length });
			return;
		}
		for (let position = span.start; position < span.end; ) {
			while (run < runs.length && runs[run]!.end <= position) run++;
			const candidate = runs[run];
			if (candidate !== undefined && candidate.start <= position) {
				const stop = Math.min(span.end, candidate.end);
				place(run, { part: index, from: position - span.start, to: stop - span.start });
				position = stop;
			} else {
				const stop = Math.min(span.end, candidate?.start ?? span.end);
				place(-1, { part: index, from: position - span.start, to: stop - span.start });
				position = stop;
			}
		}
	});
	return phrases;
}

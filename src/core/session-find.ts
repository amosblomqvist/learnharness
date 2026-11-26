/** Literal, case-insensitive session Find (owner, 2026-10-13). The DOM seam
 * supplies only displayed text; no transcript/Markdown/TeX indexing lives here. */
import { PERSIAN_IGNORABLE } from "./fuzzy.ts";

export interface SessionTextMatch {
	start: number;
	end: number;
}

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** One query character as a pattern: Persian/Arabic spellings of the same
 *  letter or digit match each other (ی ي ى, ک ك, 1 ۱ ١); everything else is
 *  an escaped literal. */
function charPattern(c: string): string {
	if ("یيى".includes(c)) return "[یيى]";
	if ("کك".includes(c)) return "[کك]";
	const d = `0123456789${PERSIAN_DIGITS}${ARABIC_DIGITS}`.indexOf(c) % 10;
	if (d >= 0) return `[${d}${PERSIAN_DIGITS[d]}${ARABIC_DIGITS[d]}]`;
	return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findSessionTextMatches(text: string, query: string): SessionTextMatch[] {
	// Escape the user's string, never expose regex semantics. RegExp retains
	// ORIGINAL UTF-16 offsets, unlike lowercasing text (İ can change length),
	// so Persian variants are matched by the pattern instead of folding the
	// text: half-spaces and vowel marks may sit between any two letters.
	const chars = [...query].filter((c) => !new RegExp(PERSIAN_IGNORABLE).test(c));
	if (chars.length === 0) return [];
	const pattern = new RegExp(chars.map(charPattern).join(`${PERSIAN_IGNORABLE}*`), "giu");
	return Array.from(text.matchAll(pattern), (m) => ({ start: m.index, end: m.index + m[0].length }));
}

export function stepSessionMatch(index: number, count: number, direction: 1 | -1): number {
	if (!count) return -1;
	return ((index + direction) % count + count) % count;
}

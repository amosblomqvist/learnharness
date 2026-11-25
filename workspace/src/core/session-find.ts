/** Literal, case-insensitive session Find (owner, 2026-10-13). The DOM seam
 * supplies only displayed text; no transcript/Markdown/TeX indexing lives here. */
export interface SessionTextMatch {
	start: number;
	end: number;
}

export function findSessionTextMatches(text: string, query: string): SessionTextMatch[] {
	if (!query) return [];
	// Escape the user's string, never expose regex semantics. RegExp retains
	// ORIGINAL UTF-16 offsets, unlike lowercasing text (İ can change length).
	const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(literal, "giu");
	return Array.from(text.matchAll(pattern), (m) => ({ start: m.index, end: m.index + m[0].length }));
}

export function stepSessionMatch(index: number, count: number, direction: 1 | -1): number {
	if (!count) return -1;
	return ((index + direction) % count + count) % count;
}

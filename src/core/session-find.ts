import { normalizeForSearch, normalizeWithMap, type NormalizedSearchText } from "./text-search.ts";

/** Literal, case-insensitive session Find (owner, 2026-10-13). The DOM seam
 * supplies only displayed text; no transcript/Markdown/TeX indexing lives here. */
export interface SessionTextMatch {
	start: number;
	end: number;
}

const NON_ASCII = /[^\x00-\x7F]/;

interface FoldedRun {
	text: string;
	/** Built on the first hit only; a miss never needs original spans. */
	spans?: NormalizedSearchText;
}

/** Find rescans every displayed run on each keystroke and each streamed frame,
 * and streaming changes only the last run, so folded runs are kept by text. */
const FOLDED_RUN_LIMIT = 4096;
const foldedRuns = new Map<string, FoldedRun>();

function foldedRun(text: string): FoldedRun {
	let run = foldedRuns.get(text);
	if (run) {
		// Re-insert, so runs still on screen outlive stale streaming prefixes.
		foldedRuns.delete(text);
	} else {
		run = { text: normalizeForSearch(text) };
		if (foldedRuns.size >= FOLDED_RUN_LIMIT) foldedRuns.delete(foldedRuns.keys().next().value!);
	}
	foldedRuns.set(text, run);
	return run;
}

let lastQuery = "";
let lastNeedle = "";

export function findSessionTextMatches(text: string, query: string): SessionTextMatch[] {
	if (!query) return [];
	if (query !== lastQuery) {
		lastNeedle = normalizeForSearch(query);
		lastQuery = query;
	}
	const needle = lastNeedle;
	if (!needle) return [];
	// ASCII folds to its own lowercase unit for unit: the offsets are its own.
	if (!NON_ASCII.test(text)) return literalMatches(text.toLowerCase(), needle);
	const run = foldedRun(text);
	if (!run.text.includes(needle)) return [];
	run.spans ??= normalizeWithMap(text);
	return literalMatches(run.text, needle, run.spans);
}

function literalMatches(folded: string, needle: string, spans?: NormalizedSearchText): SessionTextMatch[] {
	const matches: SessionTextMatch[] = [];
	for (let index = folded.indexOf(needle); index !== -1; index = folded.indexOf(needle, index + needle.length)) {
		const start = spans ? spans.map[index]! : index;
		const end = spans ? spans.ends[index + needle.length - 1]! : index + needle.length;
		const previous = matches.at(-1);
		// An expansion folds several units onto one original span: merge overlaps.
		if (previous && start < previous.end) {
			previous.end = Math.max(previous.end, end);
		} else {
			matches.push({ start, end });
		}
	}
	return matches;
}

export function stepSessionMatch(index: number, count: number, direction: 1 | -1): number {
	if (!count) return -1;
	return ((index + direction) % count + count) % count;
}

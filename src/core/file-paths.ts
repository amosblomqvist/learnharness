/** A lossless projection of plain learner text, not a Markdown parser. */
export type FilePathPart =
	| { kind: "text"; text: string; start: number; end: number }
	| { kind: "path"; text: string; path: string; start: number; end: number };

// No filesystem access or normalization: even punctuation and backslashes can
// be legitimate POSIX filename characters. Only rooted syntax is required.
function isFilePath(path: string): boolean {
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path)) return false;
	return path.startsWith("/")
		|| path.startsWith("~/")
		|| /^[a-z]:[\\/]/i.test(path)
		|| /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path);
}

/**
 * Wrap a rooted path for storage/transmission as ordinary, lossless text.
 * CommonMark's one-space padding prevents edge backticks joining delimiters.
 */
export function quoteFilePath(path: string): string {
	if (!isFilePath(path)) throw new TypeError("Expected a single-line rooted file path");
	let width = 1;
	for (const run of path.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1);
	const delimiter = "`".repeat(width);
	const padding = path.startsWith("`") || path.endsWith("`") ? " " : "";
	return `${delimiter}${padding}${path}${padding}${delimiter}`;
}

/**
 * Recognize every complete backtick-wrapped rooted path, even beside words.
 * Delimiters are whole runs of exactly equal length; a run inside another
 * code span is never reconsidered as a partial path token. Offsets are JS
 * string (UTF-16) offsets and `text` always slices the exact original input.
 */
export function parseFilePaths(text: string): FilePathPart[] {
	const runs = Array.from(text.matchAll(/`+/g), (match) => ({
		start: match.index,
		end: match.index + match[0].length,
		width: match[0].length,
	}));
	// The next same-width run lets unmatched openers remain plain text without
	// repeatedly scanning the rest of a long draft.
	const next = new Map<number, number>();
	const closing = new Map<number, number>();
	for (let i = runs.length - 1; i >= 0; i--) {
		const width = runs[i]!.width;
		const match = next.get(width);
		if (match !== undefined) closing.set(i, match);
		next.set(width, i);
	}

	const parts: FilePathPart[] = [];
	let plainStart = 0;
	for (let i = 0; i < runs.length; i++) {
		const closeIndex = closing.get(i);
		if (closeIndex === undefined) continue;
		const open = runs[i]!;
		const close = runs[closeIndex]!;
		let path = text.slice(open.end, close.start);
		// CommonMark strips exactly one space at each edge, not all whitespace.
		if (path.startsWith(" ") && path.endsWith(" ") && /[^ ]/.test(path)) {
			path = path.slice(1, -1);
		}
		if (isFilePath(path)) {
			if (plainStart < open.start) {
				parts.push({ kind: "text", text: text.slice(plainStart, open.start), start: plainStart, end: open.start });
			}
			parts.push({ kind: "path", text: text.slice(open.start, close.end), path, start: open.start, end: close.end });
			plainStart = close.end;
		}
		i = closeIndex;
	}
	if (plainStart < text.length) {
		parts.push({ kind: "text", text: text.slice(plainStart), start: plainStart, end: text.length });
	}
	return parts;
}

/** Basename for display only; the original full path remains untouched. */
export function filePathLabel(path: string): string {
	const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
	const separator = windows ? /[\\/]/ : /\//;
	const trimmed = windows ? path.replace(/[\\/]+$/, "") : path.replace(/\/+$/, "");
	if (!trimmed || (windows && /^[a-z]:$/i.test(trimmed)) || trimmed === "~") return path;
	return trimmed.split(separator).at(-1) || path;
}

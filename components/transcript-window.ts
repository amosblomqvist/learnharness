import type { Range } from "@tanstack/react-virtual";

interface Position { start: number; end: number }

/** A row count alone gives almost no runway around short tool messages.
 * Keep two screens on either side, capped so many tiny rows stay bounded. */
export function transcriptWindow(range: Range, positions: readonly Position[], viewportHeight: number): number[] {
	const first = positions[range.startIndex], last = positions[range.endIndex];
	let start = Math.max(0, range.startIndex - range.overscan);
	let end = Math.min(range.count - 1, range.endIndex + range.overscan);
	if (first && last) {
		const buffer = viewportHeight * 2;
		const lower = Math.max(0, range.startIndex - 24), upper = Math.min(range.count - 1, range.endIndex + 24);
		while (start > lower && positions[start - 1]!.end > first.start - buffer) start--;
		while (end < upper && positions[end + 1]!.start < last.end + buffer) end++;
	}
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

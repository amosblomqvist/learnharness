/** Keep the ordinary three-row buffer when shortening a long animated jump. */
export const TRANSCRIPT_OVERSCAN = 3;

export interface TranscriptJumpWindow {
	sourceStart: number;
	sourceEnd: number;
	tailStart: number;
}

interface Position { index: number; start: number; end: number }

/** Only the current viewport and the destination enter the animation. The
 * omitted middle still contributes its normal height to the scrollbar. */
export function transcriptJumpWindow(items: readonly Position[], scrollTop: number, viewportHeight: number,
	bottom: number, count: number, offsetAt: (index: number) => number): TranscriptJumpWindow | null {
	const visible = items.filter(item => item.end > scrollTop && item.start < scrollTop + viewportHeight);
	if (!visible.length || !count) return null;
	const sourceStart = Math.max(0, visible[0]!.index - TRANSCRIPT_OVERSCAN);
	const sourceEnd = Math.min(count - 1, visible.at(-1)!.index + TRANSCRIPT_OVERSCAN);
	let tailStart = count - 1;
	while (tailStart > 0 && offsetAt(tailStart - 1) >= bottom) tailStart--;
	tailStart = Math.max(0, tailStart - TRANSCRIPT_OVERSCAN);
	return tailStart <= sourceEnd + 1 ? null : { sourceStart, sourceEnd, tailStart };
}

/** Restore the visible end passage if the learner interrupts after crossing
 * the joined seam; an interruption in the starting window stays there. */
export function transcriptJumpRestoreOffset(scrollTop: number, tailStart: number, shift: number): number {
	return scrollTop >= tailStart - shift ? scrollTop + shift : scrollTop;
}

/** The native thumb traverses the full history while the two mounted
 * windows traverse only their joined distance. At the end, real and
 * displayed coordinates coincide again. */
export function transcriptJumpTravel(scrollTop: number, from: number, bottom: number, omittedHeight: number): number {
	const progress = bottom > from ? Math.max(0, Math.min(1, (scrollTop - from) / (bottom - from))) : 1;
	return progress * omittedHeight;
}

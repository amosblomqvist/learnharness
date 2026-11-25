import { cn } from "@/lib/utils";

/**
 * THE BRAILLE SPINNER (owner, minimal-color round): the one working-state
 * indicator, in the terminal's own glyph language. Pure function + CSS —
 * no JS frame timer, no React re-render per frame; each frame is a tiny
 * <g> whose opacity is compositor-animated, so the cost is below the old
 * breathing dot's (which animated opacity AND transform).
 *
 * Geometry: the classic cli-spinner sequence (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, 10 frames,
 * 80ms each — 800ms cycle) as EXACT dot bitmaps in a 2×4 braille cell
 * (dots 1-3 = left column, 4-6 = right). One shared keyframes (globals.css
 * .braille-frame) holds each frame visible for its 10% slice; frames
 * stagger via positive animation-delay, so frame 0 leads from first paint.
 *
 * Static fallback (SSR pre-hydrate, prefers-reduced-motion, print): frame
 * 0 (⠋) shows — a legible glyph, not a blank. Motion is honest here: it
 * exists only while a turn is in flight and vanishes the moment it ends.
 */
const FRAMES: ReadonlyArray<{ dots: ReadonlyArray<readonly [number, number]> }> = [
	{ dots: [[1, 1], [1, 3], [3, 1]] },
	{ dots: [[1, 1], [3, 1], [3, 3]] },
	{ dots: [[1, 1], [3, 1], [3, 3], [3, 5]] },
	{ dots: [[3, 1], [3, 3], [3, 5]] },
	{ dots: [[1, 5], [3, 1], [3, 3], [3, 5]] },
	{ dots: [[1, 5], [3, 3], [3, 5]] },
	{ dots: [[1, 3], [1, 5], [3, 5]] },
	{ dots: [[1, 1], [1, 3], [1, 5], [3, 5]] },
	{ dots: [[1, 1], [1, 3], [1, 5]] },
	{ dots: [[1, 1], [1, 3], [1, 5], [3, 1]] },
];

/** The animation constants (mirrors globals.css .braille-frame). */
export const SPINNER_FRAME_MS = 80;
export const SPINNER_FRAMES = FRAMES.length;

export function BrailleSpinner({
	className,
	label = "Working",
}: {
	/** Sizing/position classes; height drives the scale (width is the cell's 1:2 aspect). */
	className?: string;
	/** The accessible name of the state this spinner announces. */
	label?: string;
}) {
	return (
		<svg
			viewBox="0 0 4 8"
			data-testid="braille-spinner"
			role="status"
			aria-label={label}
			className={cn("h-3 w-auto shrink-0 text-foreground", className)}
		>
			{FRAMES.map((frame, k) => (
				<g
					key={k}
					className="braille-frame"
					data-frame={k}
					style={{ animationDelay: `${k * SPINNER_FRAME_MS}ms` }}
				>
					{frame.dots.map(([cx, cy]) => (
						<circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.8} className="fill-current" />
					))}
				</g>
			))}
		</svg>
	);
}

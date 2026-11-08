"use client";

import { Hint } from "@/components/ui/hint";
import type { PracticeTally } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The practice problem counter (owner, 2026-11-03): "6 done · 3 1 2" —
 * the total muted, then the outcome buckets in the outcome chips'
 * colours (green solved, amber solved with hints, red not solved).
 * Zeros show; a fresh session reads "0 done · 0 0 0". Rendered in the
 * session's top bar (always, practice sessions) and the practice dock's
 * Problem eyebrow (while a problem is active).
 *
 * lh-no-drag: a span in the top bar's drag band would never see the
 * hover that opens its hint.
 */
export function ProblemTally({ tally, side = "bottom", className }: {
	tally: PracticeTally;
	side?: "top" | "bottom";
	className?: string;
}) {
	const total = tally.solved + tally.hinted + tally.unsolved;
	const label = `Solved ${tally.solved} · With hints ${tally.hinted} · Not solved ${tally.unsolved}`;
	return (
		<Hint label={label} side={side}>
			<span
				data-testid="problem-tally"
				aria-label={`${total} done: ${label}`}
				className={cn("lh-no-drag flex shrink-0 select-none items-center gap-1.5 text-xs font-medium tabular-nums", className)}
			>
				<span className="text-muted-foreground">{total} done ·</span>
				<span data-bucket="solved" className="text-green-500">{tally.solved}</span>
				<span data-bucket="hinted" className="text-amber-500">{tally.hinted}</span>
				<span data-bucket="unsolved" className="text-red-500">{tally.unsolved}</span>
			</span>
		</Hint>
	);
}

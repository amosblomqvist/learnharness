import type { Phase3 } from "@/src/core";

/**
 * The in-session phase presentation (owner, minimal-color round —
 * monochrome now): the header chip next to the session title, and the
 * dotted boundary rule the transcript draws where the session moves into a
 * new phase. Phase COLOR is retired app-wide (phases only advance, so
 * color-as-signal was decoration); the label text carries the phase, and
 * the chip's old dot slot is repurposed for the braille spinner while a
 * turn is in flight — motion is the honest state signal. Replaces the old
 * inline plan-divider (artifact registry): the boundary is a MESSAGE-level
 * seam, so chat.tsx renders it at the message where the phase changes, not
 * inside a tool part.
 *
 * Quiet register (matches the old divider): hairline rules, small chips —
 * never a banner. Probe never renders a divider: phases only advance, so
 * probe is the start of the transcript and "Planning"/"Teaching" are the two
 * visible seams.
 *
 * Owner, minimal-color round 2: the chip is LABEL-ONLY, deliberately — a
 * working-state spinner was tried here and rejected: the pill's curve and
 * the square braille cell fought for space, and the chat surface already
 * shows in-flight work (thinking shimmer, the dock). The chip states the
 * phase; work-state is the sidebar row's spinner.
 */

/** Header-chip labels: the phases as the learner thinks of them. */
const CHIP_LABEL: Record<Phase3, string> = {
	probe: "Probing",
	plan: "Planning",
	teach: "Teaching",
};

/** The header label: the phase as a quiet flat tag (owner,
 *  extraction-UX redesign 2026-09-24 — the UN-PILL round): no border, no
 *  pill chrome, no padding — the Plan chip is the only button-shaped thing
 *  in the top bar now. Still pure decoration (owner ask, 2026-09-17): no
 *  tooltip, not selectable, not interactive in any way — no pointer events
 *  at all, so it is part of the drag surface instead of a carved-out
 *  target. */
export function PhaseChip({ phase }: { phase: Phase3 }) {
	return (
		<span
			data-testid="phase-chip"
			data-phase={phase}
			aria-hidden="true"
			className="pointer-events-none flex shrink-0 select-none items-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
		>
			{CHIP_LABEL[phase]}
		</span>
	);
}

/**
 * The transcript boundary: a monochrome dotted rule at the message where
 * the session enters `phase` (owner, minimal-color round — the label
 * carries the transition; the phase color never did). The plan seam
 * carries its node count ("Plan · 4 nodes"); teaching is just the label.
 * Null for probe (defensive — the fold never emits a probe transition
 * after the start).
 */
export function PhaseDivider({ phase, nodeCount }: { phase: Phase3; nodeCount?: number }) {
	if (phase === "probe") return null;
	const label =
		phase === "plan" && nodeCount
			? `Plan · ${nodeCount} node${nodeCount === 1 ? "" : "s"}`
			: CHIP_LABEL[phase];
	return (
		<div className="my-4 flex w-full items-center gap-3" data-testid={`phase-divider-${phase}`}>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</span>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden />
		</div>
	);
}

/**
 * The node count for a plan seam: the first plan-op tree output in the
 * message that carries the seam (the plan_init that made the phase flip).
 * Structural slice of a UI message, same shape-of-shapes as core/phases.ts.
 */
export function planNodeCount(
	message: { parts: ReadonlyArray<{ type: string; state?: string; output?: unknown; [k: string]: unknown }> },
): number | undefined {
	for (const part of message.parts) {
		if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
		const tree = (part.output as { tree?: { nodes?: unknown[] } } | undefined)?.tree;
		if (tree && Array.isArray(tree.nodes) && tree.nodes.length > 0) return tree.nodes.length;
	}
	return undefined;
}

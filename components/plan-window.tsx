"use client";

import { useId, useMemo } from "react";
import { derivedNodeStatus, derivePlanStatuses } from "@/src/core";
import {
	PlanDiagram,
	GRAPH_PAD,
	latestTree,
	TEXT_CAP_SCALE,
	usePlanLayout,
	type PopupMessage,
} from "@/components/plan-block";

/**
 * THE PLAN MARGINALIA: the plan's ambient presence in the session view —
 * the successor of the old fixed corner card (the plan window, retired
 * with the dock-band placement round). NO container: the bare diagram,
 * meet-fitted into the dock band's right flank — the wrapper (DockOverlay)
 * positions and fades it — so it reads as marginalia on the lesson's
 * page, not a floating widget. Live by construction: statuses derive from
 * the transcript on every render (derivePlanStatuses — calls, not
 * results), so the glow moves the moment a tagged check streams in.
 *
 * Visibile only while a question owns the dock band (the reserved tail's
 * height is the diagram's canvas — quiz open, tall band, full plan);
 * folding the dock fades + blurs the whole thing out of existence. The
 * top-bar plan chip carries access at every width; the popup is the study
 * view. The viewBox pad clears the current node's blurred yellow halo
 * (GLOW_REACH) at the extent edges.
 */

const MARGIN_PAD = GRAPH_PAD + 16;

/** True when the transcript holds a plan tree. Gates the marginalia's
 *  clickable flank (chat.tsx): PlanMarginalia renders null without a
 *  tree, but the WRAPPER button must unmount too — a JSX element is
 *  always truthy, so gating on it alone left a phantom click target in
 *  the bottom-right whenever a question was pending with no plan
 *  (owner report, UI round 2026-10-01). */
export function planExists(messages: readonly PopupMessage[]): boolean {
	const tree = latestTree(messages);
	return !!tree && tree.nodes.length > 0;
}

export function PlanMarginalia({ messages }: { messages: readonly PopupMessage[] }) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const tree = useMemo(() => latestTree(messages), [messages]);
	const statuses = useMemo(
		() => (tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null),
		[tree, messages],
	);
	const plan = usePlanLayout(tree);
	if (!tree || tree.nodes.length === 0) return null; // no plan yet: nothing in the margin
	const statusOf = (id: string) => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");
	return (
		<PlanDiagram
			plan={plan}
			nodes={tree.nodes}
			edges={tree.edges}
			statusOf={statusOf}
			glowId={statuses?.current ?? null}
			markerId={markerId}
			pad={MARGIN_PAD}
			textCapScale={TEXT_CAP_SCALE}
			fill
		/>
	);
}

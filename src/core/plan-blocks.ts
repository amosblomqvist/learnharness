/**
 * Plan-block emission (docs/probe-teach-split.md §6): the INTERIM plan
 * presentation seam. The plan renders IN FLOW once, at authoring — a
 * frozen snapshot attached right after the assistant group carrying the
 * successful plan_init call. It is the presentation moment for the plan
 * (and the popup's entry point) — statuses on it are accurate at that
 * instant (current = null, everything upcoming — unless the authoring is
 * a mid-lesson rewrite, in which case the snapshot shows what was true
 * then).
 *
 * Wave B (owner-approved 2026-09-26): the block is a native plan-block
 * MARKER appended at the turn's persist (idempotent per plan_init call);
 * the projection splices its data part into the assistant group IN FLOW,
 * exactly where the UIMessage-era attach put it. The neighborhood-block
 * machinery stays retired: position derives live from the transcript.
 */

import type { PlanBlockData, PlanTree } from "./contracts.ts";
import { derivePlanStatusesLh } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";
import { newPlanBlockMessage } from "./native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** The message part the chat renderer consumes (TeacherUIDataParts key
 *  "plan-block" — the SDK strips the `data-` prefix). Kept for the client
 *  renderers; the projection emits this shape. */
export interface PlanBlockPart {
	type: "data-plan-block";
	id: string;
	data: PlanBlockData;
}

/** The snapshot payload (unchanged since wave 4): statuses derived AT
 *  EMISSION time from the transcript — the block never re-derives. Wave D:
 *  the derivation reads the NATIVE transcript (quiz CALLS only — results
 *  feed nothing, contracts/plan.ts derivePlanStatusesLh). */
function snapshot(tree: PlanTree, messages: readonly LhMessage[]): PlanBlockData {
	const statuses = derivePlanStatusesLh(tree, messages);
	return {
		kind: "full",
		at: new Date().toISOString(),
		current: statuses.current,
		nodes: tree.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			status: statuses.current === n.id ? "current" : statuses.visited.has(n.id) ? "visited" : "upcoming",
		})),
		edges: tree.edges.map((e) => ({ from: e.from, to: e.to })),
	};
}

/** The plan tree a transcript implies: the tree of its last SUCCESSFUL
 *  plan_init (the one the plan tool saved), or undefined when none ran. A
 *  rewind restores the record's tree from the messages it keeps. */
export function latestPlanTreeOf(messages: readonly LhMessage[]): PlanTree | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as ToolResultMessage | undefined;
		if (m?.role !== "toolResult" || m.toolName !== "plan_init") continue;
		const details = m.details as { ok?: unknown; tree?: PlanTree } | undefined;
		if (details?.ok === true && details.tree && Array.isArray(details.tree.nodes)) return details.tree;
	}
	return undefined;
}

/** The record's plan-block markers, keyed by the plan_init call they
 *  present — the idempotency set for emission. */
export function emittedPlanBlockCalls(messages: readonly LhMessage[]): Set<string> {
	const out = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as { customType?: string; details?: { planCallId?: unknown } };
		if (marker.customType === "plan-block" && typeof marker.details?.planCallId === "string") {
			out.add(marker.details.planCallId);
		}
	}
	return out;
}

/**
 * The native emission seam (pure): ONE plan-block marker per TURN — for
 *  the turn's LAST successful plan_init call (a same-turn rewrite presents
 *  once; a later turn's rewrite gets its own block — the golden-master
 *  rule the UIMessage-era attach had) that the record hasn't already
 *  emitted. `tree` is the record's current tree (the plan tool saved it
 *  during the turn); `transcript` is the full NATIVE transcript the status
 *  derivation reads.
 */
export function planBlocksFor(
	record: readonly LhMessage[],
	newMessages: readonly LhMessage[],
	tree: PlanTree | null | undefined,
	transcript: readonly LhMessage[],
): LhMessage[] {
	if (!tree || tree.nodes.length === 0) return [];
	const emitted = emittedPlanBlockCalls(record);
	let last: { toolCallId: string } | null = null;
	for (const m of newMessages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage & { id: string };
		if (result.toolName !== "plan_init") continue;
		const ok = (result.details as { ok?: unknown } | undefined)?.ok;
		if (ok !== true) continue;
		if (emitted.has(result.toolCallId)) continue;
		last = { toolCallId: result.toolCallId };
	}
	if (!last) return [];
	return [newPlanBlockMessage(last.toolCallId, snapshot(tree, transcript))];
}

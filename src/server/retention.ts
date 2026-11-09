/**
 * Server-side retention composition (issue #33): the due surface for
 * GET /api/graph/reviews, and the practice-conclude capture hook wired into
 * the practitioner's tools at the composition root (chat-handler).
 *
 * Both are thin transport over the pure core (core/retention.ts) and the
 * review store port (stores.reviewStore — src/store/reviews.ts). Capture
 * failures are logged and never surface into the conclude result: a
 * scheduling bookkeeping error must not break the practice session.
 */

import { applyConcludeOutcome, duePropositions, ratingFromOutcome, type DueReview, type PracticeOutcome } from "../core/retention.ts";
import { getGraph } from "../core/graph.ts";
import type { LhMessage, LhMarkerMessage } from "../core/native-messages.ts";
import type { ChatStore, ReviewStore } from "../core/ports.ts";
import { stores } from "./stores.ts";

/** The GET /api/graph/reviews payload: the due count + list (most overdue
 *  first, capped at MAX_REVIEW_PICKS), computed from the current graph and
 *  the review ledger. A pure read — nothing here schedules or writes. */
export function reviewStatus(): { count: number; due: DueReview[] } {
	const due = duePropositions(
		getGraph(stores.graphStore).nodes,
		stores.reviewStore.readReviews(),
		new Date(),
	);
	return { count: due.length, due };
}

// ─── the conclude capture hook ───────────────────────────────────────────────

/** The graph-context marker's picks (the session's explicit graph selection
 *  at creation — message[0] of a picked session). Tolerant: any custom
 *  graph-context message's proposition ids count; absent = []. */
function graphContextPickIds(messages: ReadonlyArray<LhMessage>): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if ((message as { role?: string }).role !== "custom") continue;
		if ((message as LhMarkerMessage).customType !== "graph-context") continue;
		const propositions = (message as LhMarkerMessage).details as { propositions?: unknown } | undefined;
		if (!Array.isArray(propositions?.propositions)) continue;
		for (const pick of propositions.propositions) {
			if (typeof pick === "object" && pick !== null && typeof (pick as { id?: unknown }).id === "string") {
				ids.add((pick as { id: string }).id);
			}
		}
	}
	return ids;
}

/** The pose-side targets of the concluded problem (the problem tool's
 *  canonical `target` ids — names were normalized to ids at the seam). */
function problemTargetIds(problem: { input: unknown } | null): string[] {
	const target = (problem?.input as { target?: unknown } | undefined)?.target;
	return Array.isArray(target) && target.every((t): t is string => typeof t === "string") ? target : [];
}

/** What the practitioner's conclude tool hands the capture (its own input
 *  vocabulary — src/agent/tools/practice.ts ConcludeInput). */
export interface ConcludeCaptureInput {
	outcome: unknown;
}

/**
 * The retention capture hook for one practice session: on every clean
 * conclude, schedule the concluded problem's picked target propositions
 * (correct → Good, hinted → Hard, incorrect → Again — core/retention.ts).
 * Pickless sessions and untagged problems capture nothing; writes are
 * read-modify-write over the review ledger; nothing ever throws into the
 * conclude (failures are logged).
 */
export function reviewCapture(
	deps: { chatStore: Pick<ChatStore, "getChat">; reviewStore: ReviewStore },
	chatId: string,
): (conclude: ConcludeCaptureInput, problem: { toolCallId: string; input: unknown } | null) => void {
	return (conclude, problem) => {
		try {
			const outcome = conclude.outcome;
			if (typeof outcome !== "string" || ratingFromOutcome(outcome as PracticeOutcome) === null) return;
			const record = deps.chatStore.getChat(chatId);
			if (!record) return;
			const picks = graphContextPickIds(record.messages);
			if (picks.size === 0) return; // a pickless practice session schedules nothing
			const targets = problemTargetIds(problem);
			if (targets.length === 0) return; // an untagged problem exercises nothing schedulable
			const reviews = deps.reviewStore.readReviews();
			const next = applyConcludeOutcome(
				reviews,
				picks,
				targets,
				outcome as PracticeOutcome,
				new Date(),
				chatId,
			);
			if (next !== reviews) deps.reviewStore.writeReviews(next);
		} catch (err) {
			console.error(`[retention] conclude capture failed for chat ${chatId}:`, err);
		}
	};
}

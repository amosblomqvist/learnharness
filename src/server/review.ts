/**
 * SCHEDULED PRACTICE — the server half (spaced repetition, 2026-11-02).
 *
 * The review log is fed from SAVED practice records only, never from a
 * tool's mid-turn execute: a turn that fails before persistTurn leaves no
 * review behind a transcript that lost it. Sync points:
 *  - practice-turn settlement (chat-handler onFinish, after persistTurn
 *    and the parked dismissal, before endTurn);
 *  - the idle dismiss route (its marker lands outside any turn);
 *  - chat deletion, before the record goes (the log outlives the chat);
 *  - a lazy whole-store backfill on the first queue read per process.
 * Every sync is idempotent by review id (chatId:problemCallId).
 *
 * Every read schedules with the resolved review settings (newPerDay and
 * the FSRS knobs — core/settings.ts ReviewSettings).
 */

import { getGraph } from "../core/graph.ts";
import {
	formatReviewBrief,
	practiceReviewsOf,
	reviewBriefOf,
	reviewQueue,
	reviewSchedule,
	type ReviewCardFacts,
	type ReviewSchedule,
} from "../core/review.ts";
import type { ReviewSettings } from "../core/settings.ts";
import type { ChatStore, GraphStore, ReviewStore } from "../core/ports.ts";
import { effectiveSettings, stores } from "./stores.ts";

type ReviewDeps = {
	chatStore: Pick<ChatStore, "getChat" | "listChats">;
	reviewStore: ReviewStore;
};

/** Append one practice chat's not-yet-logged reviews. Teach chats and
 *  unknown ids are no-ops. Returns how many lines were appended. */
export function syncChatReviews(chatId: string, deps: ReviewDeps = stores): number {
	const record = deps.chatStore.getChat(chatId);
	if (!record || record.kind !== "practice") return 0;
	const logged = new Set(deps.reviewStore.readReviews().map((r) => r.id));
	const fresh = practiceReviewsOf(chatId, record.messages).filter((r) => !logged.has(r.id));
	deps.reviewStore.appendReviews(fresh);
	return fresh.length;
}

/** The settlement/route/deletion seam: a review sync must never fail the
 *  work it rides on — log and move on (the next backfill catches up). */
export function syncChatReviewsSafely(chatId: string): void {
	try {
		syncChatReviews(chatId);
	} catch (err) {
		console.error(`[chat ${chatId}] review sync failed:`, err);
	}
}

/** Fold every practice chat into the log (idempotent). */
export function backfillReviews(deps: ReviewDeps = stores): number {
	const logged = new Set(deps.reviewStore.readReviews().map((r) => r.id));
	const fresh = [];
	for (const summary of deps.chatStore.listChats()) {
		if (summary.kind !== "practice") continue;
		const record = deps.chatStore.getChat(summary.id);
		if (!record) continue;
		for (const review of practiceReviewsOf(summary.id, record.messages)) {
			if (!logged.has(review.id)) fresh.push(review);
		}
	}
	deps.reviewStore.appendReviews(fresh);
	return fresh.length;
}

interface LhReviewGlobal {
	__lhReviewBackfilled?: boolean;
}

/** The once-per-process backfill (globalThis-backed so separate Next
 *  module entries share it — the turn-liveness lesson). */
export function ensureReviewBackfill(): void {
	const g = globalThis as typeof globalThis & LhReviewGlobal;
	if (g.__lhReviewBackfilled) return;
	backfillReviews();
	g.__lhReviewBackfilled = true;
}

export interface ReviewPick {
	id: string;
	name: string;
	statement: string;
}

export interface ReviewSummary {
	/** Practiced propositions due now. */
	dueCount: number;
	/** Never-practiced propositions today's allowance still admits. */
	newCount: number;
	/** The next review session's propositions (due first, then new). */
	picks: ReviewPick[];
}

type ReviewReadDeps = { graphStore: Pick<GraphStore, "readNodes" | "readChains">; reviewStore: ReviewStore };

/** GET /api/review's payload: the queue over the live graph. */
export function reviewSummary(
	now: Date = new Date(),
	deps: ReviewReadDeps = stores,
	review: Required<ReviewSettings> = effectiveSettings().review,
): ReviewSummary {
	const graph = getGraph(deps.graphStore);
	const queue = reviewQueue({
		reviews: deps.reviewStore.readReviews(),
		nodes: graph.nodes,
		chains: graph.chains,
		now,
		newPerDay: review.newPerDay,
		scheduler: review,
	});
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	return {
		dueCount: queue.due.length,
		newCount: queue.newAvailable.length,
		picks: queue.picks.map((id) => {
			const node = byId.get(id)!;
			return { id, name: node.name, statement: node.statement };
		}),
	};
}

/** The history brief's session-context lines for a practice session's
 *  picks (chat creation). Backfills first, so the log holds every saved
 *  practice chat. A brief must never fail the creation it rides on — log
 *  and start the session without one. */
export function reviewBriefLines(
	pickIds: readonly string[],
	now: Date = new Date(),
	deps: { reviewStore: ReviewStore } = stores,
): string[] {
	try {
		ensureReviewBackfill();
		const scheduler = effectiveSettings().review;
		return formatReviewBrief(reviewBriefOf({ reviews: deps.reviewStore.readReviews(), pickIds, now, scheduler }));
	} catch (err) {
		console.error("review brief failed:", err);
		return [];
	}
}

/** The heatmap window: 26 weeks either side of today (2026-11-02). */
export const REVIEW_SCHEDULE_WINDOW_DAYS = 26 * 7;

/** A due card with the live proposition's name and statement. */
export type ReviewScheduleCard = ReviewCardFacts & { name: string; statement: string };

/** GET /api/review/schedule's payload: the Settings > Review heatmap. */
export interface ReviewScheduleView extends Omit<ReviewSchedule, "future" | "newToday"> {
	future: { date: string; due: ReviewScheduleCard[] }[];
	newToday: ReviewPick[];
}

export function reviewScheduleView(
	now: Date = new Date(),
	deps: ReviewReadDeps = stores,
	review: Required<ReviewSettings> = effectiveSettings().review,
): ReviewScheduleView {
	const graph = getGraph(deps.graphStore);
	const schedule = reviewSchedule({
		reviews: deps.reviewStore.readReviews(),
		nodes: graph.nodes,
		chains: graph.chains,
		now,
		newPerDay: review.newPerDay,
		scheduler: review,
		pastDays: REVIEW_SCHEDULE_WINDOW_DAYS,
		futureDays: REVIEW_SCHEDULE_WINDOW_DAYS,
	});
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const named = (id: string) => {
		const node = byId.get(id)!;
		return { name: node.name, statement: node.statement };
	};
	return {
		...schedule,
		future: schedule.future.map((day) => ({ ...day, due: day.due.map((card) => ({ ...card, ...named(card.id) })) })),
		newToday: schedule.newToday.map((id) => ({ id, ...named(id) })),
	};
}

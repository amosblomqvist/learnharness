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

import type { Cluster } from "../core/contracts.ts";
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
import { graphView } from "./graph.ts";
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

/** One never-practiced proposition in the new-problems block. */
export interface NewProblem extends ReviewPick {
	/** In today's allowance (the schedule's newToday). */
	today: boolean;
}

/** One topic of the new-problems block (Settings > Review, 2026-11-03). */
export interface NewProblemTopic {
	/** The labeled graph region's id; null for Other. */
	id: string | null;
	/** The region's label; null for Other. */
	label: string | null;
	/** Its problems, in introduction order. */
	problems: NewProblem[];
}

/**
 * The new backlog grouped by topic. A topic is a LABELED graph region
 * (the snapshot's clusters with a label — owner, 2026-11-03: "graph
 * regions only"); everything else (sessions under the hull size, regions
 * whose chat is gone) falls into Other. Topics sort by count desc, ties
 * by label then id; Other always last. Problems keep introduction order.
 */
export function groupNewBacklog(
	backlog: readonly ReviewPick[],
	today: readonly string[],
	regions: readonly Pick<Cluster, "id" | "label" | "members">[],
): NewProblemTopic[] {
	const todaySet = new Set(today);
	const regionOf = new Map<string, Pick<Cluster, "id" | "label">>();
	for (const region of regions) {
		if (region.label === null) continue;
		for (const member of region.members) regionOf.set(member, region);
	}
	const topics = new Map<string, NewProblemTopic>();
	const other: NewProblemTopic = { id: null, label: null, problems: [] };
	for (const pick of backlog) {
		const problem = { ...pick, today: todaySet.has(pick.id) };
		const region = regionOf.get(pick.id);
		if (!region) {
			other.problems.push(problem);
			continue;
		}
		let topic = topics.get(region.id);
		if (!topic) {
			topic = { id: region.id, label: region.label, problems: [] };
			topics.set(region.id, topic);
		}
		topic.problems.push(problem);
	}
	const named = [...topics.values()].sort(
		(a, b) => b.problems.length - a.problems.length || a.label!.localeCompare(b.label!) || a.id!.localeCompare(b.id!),
	);
	return other.problems.length > 0 ? [...named, other] : named;
}

/** GET /api/review/schedule's payload: the Settings > Review heatmap and
 *  its new-problems block. */
export interface ReviewScheduleView extends Omit<ReviewSchedule, "future" | "newToday" | "newBacklog"> {
	future: { date: string; due: ReviewScheduleCard[] }[];
	newToday: ReviewPick[];
	newBacklog: NewProblemTopic[];
}

export function reviewScheduleView(
	now: Date = new Date(),
	deps: ReviewReadDeps = stores,
	review: Required<ReviewSettings> = effectiveSettings().review,
	regions: () => readonly Pick<Cluster, "id" | "label" | "members">[] = () => graphView().clusters,
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
		newBacklog: groupNewBacklog(
			schedule.newBacklog.map((id) => ({ id, ...named(id) })),
			schedule.newToday,
			regions(),
		),
	};
}

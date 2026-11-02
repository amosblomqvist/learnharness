/**
 * SCHEDULED PRACTICE (spaced repetition over practice, 2026-11-02): the
 * pure half. Three folds, no IO:
 *
 *  - practiceReviewsOf: a practice record → its reviews (one per
 *    concluded, targeted problem). The sync seam reads SAVED records only,
 *    so the log never holds a conclude the transcript lost.
 *  - ratingOf: outcome + hint rung → an FSRS rating (Again/Hard/Good;
 *    Easy is never assigned — the agent has no effortlessness signal).
 *  - reviewQueue: the log + the live graph → what is due, what new
 *    propositions today's allowance admits, and the next session's picks.
 *
 * Memory state is DERIVED by replaying the log through FSRS on every
 * read — never stored (contracts/review.ts).
 */

import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import type { ReviewEvent, ReviewOutcome, ReviewRung } from "./contracts/review.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";

/** Anki's rollover: study before 4 AM counts toward the previous day. */
export const REVIEW_DAY_START_HOUR = 4;
/** How many propositions one review session picks. */
export const REVIEW_SESSION_SIZE = 8;

const OUTCOMES: readonly ReviewOutcome[] = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"];
const RUNGS: readonly Exclude<ReviewRung, null>[] = ["R0", "R1", "R2", "R3", "R4", "R5"];

// ─── record → reviews ────────────────────────────────────────────────────────

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments?: unknown };

function targetsOf(args: unknown): string[] {
	const target = (args as { target?: unknown } | undefined)?.target;
	if (!Array.isArray(target)) return [];
	return [...new Set(target.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

function rungOf(raw: unknown): ReviewRung {
	return RUNGS.includes(raw as Exclude<ReviewRung, null>) ? (raw as ReviewRung) : null;
}

/**
 * Every concluded, targeted problem of one practice record, in record
 * order. Calls count only through CLEAN results (the honest-activation
 * law of activeProblemOf): a conclude attaches to the newest cleanly-posed
 * problem before it (problemInputForConclude's walk). A dismissal marker
 * concludes its problem as "dismissed"; the synthesized conclude that
 * later follows it is the same problem, so identity dedupes it away.
 * Untagged problems are not reviews.
 */
export function practiceReviewsOf(chatId: string, messages: readonly LhMessage[]): ReviewEvent[] {
	const resultAt = new Map<string, number>();
	for (const m of messages) {
		if (m.role !== "toolResult" || m.isError) continue;
		resultAt.set(m.toolCallId, m.timestamp);
	}
	const posed = new Map<string, unknown>(); // clean problem call id → its arguments
	const reviews: ReviewEvent[] = [];
	const seen = new Set<string>();
	const emit = (problemCallId: string, at: number, outcome: unknown, rung: unknown) => {
		if (seen.has(problemCallId) || !posed.has(problemCallId)) return;
		if (!OUTCOMES.includes(outcome as ReviewOutcome)) return;
		const targets = targetsOf(posed.get(problemCallId));
		if (targets.length === 0) return;
		seen.add(problemCallId);
		reviews.push({
			id: `${chatId}:${problemCallId}`,
			chatId,
			problemCallId,
			at: new Date(at).toISOString(),
			targets,
			outcome: outcome as ReviewOutcome,
			rung: outcome === "dismissed" ? null : rungOf(rung),
		});
	};

	let active: string | null = null;
	for (const m of messages) {
		if (m.role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType !== "problem-dismissed") continue;
			const problemCallId = (marker.details as { problemCallId?: unknown } | undefined)?.problemCallId;
			if (typeof problemCallId === "string") emit(problemCallId, marker.timestamp, "dismissed", null);
			if (problemCallId === active) active = null;
			continue;
		}
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			const call = block as ToolCallBlock;
			const at = resultAt.get(call.id);
			if (at === undefined) continue; // errored or dangling: it never happened
			if (call.name === PRACTICE_PROBLEM_TOOL) {
				posed.set(call.id, call.arguments);
				active = call.id;
			} else if (call.name === PRACTICE_CONCLUDE_TOOL && active !== null) {
				const args = (call.arguments ?? {}) as { outcome?: unknown; rung?: unknown };
				emit(active, at, args.outcome, args.rung);
				active = null;
			}
		}
	}
	return reviews;
}

// ─── outcome → rating ────────────────────────────────────────────────────────

/** The grading table: the hint record wins over the outcome word — a
 *  "solved" that needed R2 rates like a hinted solve. */
export function ratingOf(outcome: ReviewOutcome, rung: ReviewRung): Grade {
	if (outcome !== "solved" && outcome !== "solvedWithHints") return Rating.Again;
	if (rung === "R3" || rung === "R4" || rung === "R5") return Rating.Again;
	if (outcome === "solvedWithHints" || rung === "R2") return Rating.Hard;
	return Rating.Good;
}

// ─── the queue ───────────────────────────────────────────────────────────────

export interface ReviewQueueInput {
	reviews: readonly ReviewEvent[];
	/** The LIVE propositions (core/graph.ts getGraph — merged by id). */
	nodes: readonly Pick<GraphNode, "id" | "createdAt">[];
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[];
	now: Date;
	/** Never-practiced propositions admitted per day. */
	newPerDay: number;
	dayStartHour?: number;
	sessionSize?: number;
}

export interface ReviewQueue {
	/** Practiced propositions whose FSRS due date has passed, most overdue first. */
	due: string[];
	/** Never-practiced propositions today's allowance still admits, in introduction order. */
	newAvailable: string[];
	/** The next session's propositions: due first, then new, capped at the session size. */
	picks: string[];
}

const scheduler = fsrs({ request_retention: 0.9, enable_short_term: true, enable_fuzz: false });

/** The start of the review day containing `now` (local time). */
export function reviewDayStart(now: Date, dayStartHour = REVIEW_DAY_START_HOUR): Date {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), dayStartHour);
	if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
	return start;
}

/** Replay one proposition's reviews (oldest first) into its FSRS card. */
function replay(events: readonly { at: Date; grade: Grade }[]): Card {
	let card = createEmptyCard(events[0]!.at);
	for (const event of events) card = scheduler.next(card, event.at, event.grade).card;
	return card;
}

/** The first `limit` never-practiced propositions in introduction order:
 *  premises before the conclusions they feed (chain edges among the new
 *  set), ties and cycles broken by creation date, then id. Each step
 *  scans the remaining set, so the walk stops at `limit` — only today's
 *  allowance is ever needed, never the whole order. */
function introductionOrder(
	fresh: readonly Pick<GraphNode, "id" | "createdAt">[],
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[],
	limit: number,
): string[] {
	const ids = new Set(fresh.map((n) => n.id));
	const rank = new Map(
		[...fresh]
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.map((n, i) => [n.id, i]),
	);
	const blockers = new Map<string, Set<string>>(fresh.map((n) => [n.id, new Set<string>()]));
	const feeds = new Map<string, Set<string>>(fresh.map((n) => [n.id, new Set<string>()]));
	for (const chain of chains) {
		if (!ids.has(chain.conclusion)) continue;
		for (const premise of chain.premises) {
			if (!ids.has(premise) || premise === chain.conclusion) continue;
			blockers.get(chain.conclusion)!.add(premise);
			feeds.get(premise)!.add(chain.conclusion);
		}
	}
	const order: string[] = [];
	const remaining = new Set(ids);
	while (remaining.size > 0 && order.length < limit) {
		let next: string | null = null;
		for (const id of remaining) {
			if (blockers.get(id)!.size > 0) continue;
			if (next === null || rank.get(id)! < rank.get(next)!) next = id;
		}
		// A cycle: release its oldest member.
		if (next === null) for (const id of remaining) if (next === null || rank.get(id)! < rank.get(next)!) next = id;
		remaining.delete(next!);
		order.push(next!);
		for (const conclusion of feeds.get(next!)!) blockers.get(conclusion)!.delete(next!);
	}
	return order;
}

/**
 * What to practice now. Every live proposition is enrolled: practiced
 * ones are scheduled by their FSRS replay; never-practiced ones enter at
 * `newPerDay` a day (a proposition spends its slot on its FIRST logged
 * review, so an abandoned pick is offered again). Reviews naming deleted
 * propositions are skipped; a multi-target review rates every target.
 */
export function reviewQueue(input: ReviewQueueInput): ReviewQueue {
	const dayStartHour = input.dayStartHour ?? REVIEW_DAY_START_HOUR;
	const sessionSize = input.sessionSize ?? REVIEW_SESSION_SIZE;
	const live = new Set(input.nodes.map((n) => n.id));

	const history = new Map<string, { at: Date; grade: Grade; id: string }[]>();
	for (const review of input.reviews) {
		const at = new Date(review.at);
		if (Number.isNaN(at.getTime())) continue;
		const grade = ratingOf(review.outcome, review.rung);
		for (const target of review.targets) {
			if (!live.has(target)) continue;
			const list = history.get(target) ?? [];
			list.push({ at, grade, id: review.id });
			history.set(target, list);
		}
	}

	const dayStart = reviewDayStart(input.now, dayStartHour).getTime();
	const dueAt: { id: string; due: number }[] = [];
	let introducedToday = 0;
	for (const [id, events] of history) {
		events.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
		if (events[0]!.at.getTime() >= dayStart) introducedToday++;
		const due = replay(events).due.getTime();
		if (due <= input.now.getTime()) dueAt.push({ id, due });
	}
	const due = dueAt.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id)).map((d) => d.id);

	const allowance = Math.max(0, input.newPerDay - introducedToday);
	const fresh = input.nodes.filter((n) => !history.has(n.id));
	const newAvailable = allowance === 0 ? [] : introductionOrder(fresh, input.chains, allowance);

	return { due, newAvailable, picks: [...due, ...newAvailable].slice(0, sessionSize) };
}

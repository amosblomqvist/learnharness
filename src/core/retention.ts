/**
 * Retention — the review ledger's pure core (issue #33): per-proposition
 * FSRS memory state, due derivation, and the practice-conclude → rating
 * mapping. The scheduler itself is core/fsrs.ts; this module owns the
 * PERSISTED shapes (graph/reviews.json — ISO dates, the session that last
 * touched the entry) and every proposition-level fold. Pure like the rest
 * of src/core: storage arrives through ports (core/ports.ts ReviewStore).
 */

import type { GraphNode } from "./contracts.ts";
import {
	AGAIN,
	GOOD,
	HARD,
	newCard,
	retrievability,
	schedule,
	type FSRSCard,
	type FSRSState,
	type Rating,
} from "./fsrs.ts";
export type { FSRSCard, FSRSState, Rating } from "./fsrs.ts";

/** The retrievability fraction a proposition must fall below (or its dueAt
 *  pass) to count as due — the model's canonical 0.9 target. */
export const REVIEW_DUE_RETENTION = 0.9;

/** How many due propositions one review session carries, max — the same cap
 *  the chat-creation route applies to explicit graph picks. */
export const MAX_REVIEW_PICKS = 64;

/** One proposition's persisted review state (graph/reviews.json's value):
 * the FSRS card plus ledger bookkeeping — ISO dates and the session that
 * last wrote the entry. Absent from the map = never scheduled (New). */
export interface ReviewEntry {
	state: FSRSState;
	difficulty: number;
	stability: number;
	reps: number;
	lapses: number;
	/** ISO — the last rating's instant. */
	lastReviewAt: string;
	/** ISO — when this proposition should come back (lastReviewAt + interval). */
	dueAt: string;
	/** The chat whose practice conclude last updated this entry. */
	updatedInSession: string;
}

/** The whole ledger: propositionId → entry. */
export type ReviewLedger = Record<string, ReviewEntry>;

// ─── card ⇄ entry (the persistence seam) ─────────────────────────────────────

/** The pure card of one entry (dates as epoch ms). */
export function cardOf(entry: ReviewEntry): FSRSCard {
	return {
		state: entry.state,
		difficulty: entry.difficulty,
		stability: entry.stability,
		reps: entry.reps,
		lapses: entry.lapses,
		lastReview: Date.parse(entry.lastReviewAt),
	};
}

/** Persist a scheduled card as an entry. */
function entryOf(card: FSRSCard, intervalDays: number, session: string): ReviewEntry {
	return {
		state: card.state,
		difficulty: card.difficulty,
		stability: card.stability,
		reps: card.reps,
		lapses: card.lapses,
		lastReviewAt: new Date(card.lastReview!).toISOString(),
		dueAt: new Date(card.lastReview! + intervalDays * 86_400_000).toISOString(),
		updatedInSession: session,
	};
}

// ─── due derivation ──────────────────────────────────────────────────────────

/** One due proposition — the review affordance's payload. */
export interface DueReview {
	id: string;
	name: string;
	statement: string;
	state: FSRSState;
	/** Predicted recall right now (0..1]. */
	retrievability: number;
	/** ISO — when this proposition came/will come due. */
	dueAt: string;
}

/**
 * The due propositions, most overdue first. A proposition is due when its
 * ledger entry exists AND either retrievability has decayed below
 * REVIEW_DUE_RETENTION or the entry's dueAt has passed (state ≠ New).
 * Propositions with no entry are never due — the ledger is seeded by
 * practice concludes, so "never practiced" means "not scheduled", not
 * "due". Entries whose proposition left the graph are ignored (the graph
 * is the live world; the ledger follows it).
 */
export function duePropositions(
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement">>,
	reviews: Readonly<ReviewLedger>,
	now: Date,
): DueReview[] {
	const due: DueReview[] = [];
	for (const node of nodes) {
		const entry = reviews[node.id];
		if (!entry) continue;
		const card = cardOf(entry);
		const r = retrievability(card, now.getTime());
		const overdue = entry.state !== "New" && Date.parse(entry.dueAt) <= now.getTime();
		if (!overdue && r >= REVIEW_DUE_RETENTION) continue;
		due.push({ id: node.id, name: node.name, statement: node.statement, state: entry.state, retrievability: r, dueAt: entry.dueAt });
	}
	return due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || (a.id < b.id ? -1 : 1)).slice(0, MAX_REVIEW_PICKS);
}

// ─── practice outcomes → ratings ─────────────────────────────────────────────

/** A conclude call's outcome vocabulary (the practice tool's union). */
export type PracticeOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";

/**
 * The conclude → rating table (issue #33's capture rule): correct → Good,
 * correct-with-hints → Hard, incorrect → Again. A dismissal is a UI
 * discard, not a recall attempt — it schedules nothing (null).
 */
export function ratingFromOutcome(outcome: PracticeOutcome): Rating | null {
	switch (outcome) {
		case "solved":
			return GOOD;
		case "solvedWithHints":
			return HARD;
		case "movedOn":
		case "surrendered":
			return AGAIN;
		case "dismissed":
			return null;
	}
}

/**
 * Fold one concluded practice problem into the ledger (pure): every target
 * proposition of the session's selection gets the outcome's rating through
 * the FSRS scheduler. Targets the session did NOT pick are left alone —
 * the session's explicit graph selection is the capture's scope. When
 * nothing applies (a dismissed outcome, no targets, or no picked targets)
 * the SAME map reference returns — callers skip the write on identity.
 */
export function applyConcludeOutcome(
	reviews: Readonly<ReviewLedger>,
	pickedIds: ReadonlySet<string>,
	targets: ReadonlyArray<string>,
	outcome: PracticeOutcome,
	now: Date,
	session: string,
): ReviewLedger {
	const rating = ratingFromOutcome(outcome);
	if (rating === null || targets.length === 0) return reviews as ReviewLedger;
	const next: ReviewLedger = { ...reviews };
	let applied = false;
	for (const id of targets) {
		if (!pickedIds.has(id)) continue;
		const card = next[id] ? cardOf(next[id]) : newCard();
		const { card: scheduled, interval } = schedule(card, rating, now.getTime());
		next[id] = entryOf(scheduled, interval, session);
		applied = true;
	}
	return applied ? next : (reviews as ReviewLedger);
}

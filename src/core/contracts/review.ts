/**
 * Review-log contracts — spaced repetition over practice (scheduled
 * practice, 2026-11-02). Every concluded, targeted practice problem
 * becomes ONE review line: the raw facts of how it went, never a rating
 * and never a memory state. The FSRS state per proposition is DERIVED by
 * replaying these lines (core/review.ts) — the graph doctrine "derived,
 * never stored" carried over to the learner side.
 *
 * The log lives apart from both chats and graph (data/review/), so a
 * deleted practice session keeps its review history and the graph stays
 * an objective world-model with no learner state in it.
 */

/** The review-family format version this build writes and understands
 *  (the data/review/format.json sidecar — src/store/review.ts). */
export const CURRENT_REVIEW_FORMAT_VERSION = 1;

/** The conclude outcomes a review can carry (the conclude tool's enum;
 *  "dismissed" is the synthesized learner discard). */
export type ReviewOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";

/** The hint-ladder rung the problem needed; null = no hint given. */
export type ReviewRung = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | null;

/** One review: one concluded practice problem. Identity is the problem
 *  — a dismissal marker and its later synthesized conclude are the same
 *  review. Every target shares the problem's outcome. */
export interface ReviewEvent {
	/** chatId + ":" + problemCallId — the idempotency key of every sync. */
	id: string;
	chatId: string;
	problemCallId: string;
	/** ISO — when the problem concluded (the conclude result's timestamp,
	 *  or the dismissal marker's). */
	at: string;
	/** Graph proposition ids the problem exercised (never empty — untagged
	 *  problems are not reviews). */
	targets: string[];
	outcome: ReviewOutcome;
	rung: ReviewRung;
}

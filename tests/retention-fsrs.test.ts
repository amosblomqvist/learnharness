/**
 * FSRS-4.5 scheduler property tests (issue #33, retention) — the pure
 * core's invariants, no IO:
 *
 *  - the forgetting curve: range (0,1], monotone in t, exactly 0.9 at
 *    t = S (the FACTOR = 19/81 identity), 1 before any review;
 *  - stability never decreases across passing ratings, and dueAt moves
 *    monotonically forward for passing ratings taken at due time;
 *  - Again lapses a Review card into Relearning (lapses+1, stability
 *    reset toward the post-lapse value);
 *  - the first rating seeds S0(G) = w[G-1];
 *  - schedule() never mutates its input.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGAIN,
	EASY,
	FACTOR,
	FSRS_DEFAULT_PARAMETERS,
	GOOD,
	HARD,
	newCard,
	retrievability,
	schedule,
	type FSRSCard,
} from "../src/core/fsrs.ts";

const DAY = 86_400_000;
/** A Review-state card with the FSRS-4.5 defaults' typical post-Good state. */
function reviewCard(stability = 3.7145, difficulty = 5.2, reps = 1): FSRSCard {
	return { state: "Review", difficulty, stability, reps, lapses: 0, lastReview: Date.UTC(2026, 0, 1) };
}

describe("the FSRS-4.5 forgetting curve", () => {
	it("retrievability is 1 before any review and stays in (0, 1]", () => {
		assert.equal(retrievability(newCard(), 0), 1);
		const card = reviewCard();
		for (const days of [0, 0.1, 1, 3.7145, 10, 100, 365, 36500]) {
			const r = retrievability(card, card.lastReview! + days * DAY);
			assert.ok(r > 0 && r <= 1, `R(t=${days}d)=${r} must be in (0, 1]`);
		}
	});

	it("R(t, S) is exactly 0.9 at t = S (the FACTOR identity)", () => {
		for (const s of [0.5, 3.7145, 13.8206, 100]) {
			const card = reviewCard(s);
			const r = retrievability(card, card.lastReview! + s * DAY);
			assert.ok(Math.abs(r - 0.9) < 1e-9, `R(S=${s}) = ${r}, expected 0.9`);
		}
		// And FACTOR itself is the published 19/81.
		assert.ok(Math.abs(FACTOR - 19 / 81) < 1e-12);
	});

	it("retrievability strictly decreases with elapsed time", () => {
		const card = reviewCard(10);
		let prev = 1.1;
		for (const days of [0, 1, 2, 4, 8, 16, 32, 64]) {
			const r = retrievability(card, card.lastReview! + days * DAY);
			assert.ok(r < prev, `R must strictly decrease (t=${days}d, R=${r})`);
			prev = r;
		}
	});
});

describe("the scheduler's state machine", () => {
	it("the first rating seeds initial stability S0(G) = w[G-1]", () => {
		const now = Date.UTC(2026, 0, 1);
		for (const [rating, w] of [
			[AGAIN, 0],
			[HARD, 1],
			[GOOD, 2],
			[EASY, 3],
		] as const) {
			const { card } = schedule(newCard(), rating, now);
			assert.equal(card.state === "New" ? 0 : card.stability, FSRS_DEFAULT_PARAMETERS[w]!, `S0(${rating}) = w[${w}]`);
			assert.equal(card.reps, 1);
			assert.equal(card.state === "Review" || card.state === "Learning", true, `${rating} leaves New`);
		}
		// Easy graduates straight to Review; the others sit in Learning.
		assert.equal(schedule(newCard(), EASY, now).card.state, "Review");
		assert.equal(schedule(newCard(), GOOD, now).card.state, "Learning");
	});

	it("Again lapses a Review card into Relearning with lapses+1", () => {
		const card = reviewCard(20, 5, 3);
		card.lapses = 2;
		const { card: next } = schedule(card, AGAIN, card.lastReview! + 20 * DAY);
		assert.equal(next.state, "Relearning");
		assert.equal(next.lapses, 3);
		// Post-lapse stability collapses well below the pre-lapse value.
		assert.ok(next.stability < card.stability, `S'f (${next.stability}) < S (${card.stability})`);
	});

	it("Again on a Learning card stays Learning and never counts a lapse", () => {
		const first = schedule(newCard(), GOOD, Date.UTC(2026, 0, 1)).card;
		const { card: next } = schedule(first, AGAIN, Date.UTC(2026, 0, 1, 0, 1));
		assert.equal(next.state, "Learning");
		assert.equal(next.lapses, 0);
	});

	it("Good graduates a Learning card to Review; Hard stays in the ladder", () => {
		const learning = schedule(newCard(), GOOD, Date.UTC(2026, 0, 1)).card;
		const graduated = schedule(learning, GOOD, Date.UTC(2026, 0, 1, 0, 10));
		assert.equal(graduated.card.state, "Review");
		assert.ok(graduated.interval >= 1, "a graduated interval is at least a day");
		const stayed = schedule(learning, HARD, Date.UTC(2026, 0, 1, 0, 10));
		assert.equal(stayed.card.state, "Learning");
		assert.ok(stayed.interval < 1, "the step ladder is sub-day");
	});

	it("schedule never mutates its input card", () => {
		const card = reviewCard();
		const before = JSON.stringify(card);
		schedule(card, AGAIN, card.lastReview! + DAY);
		schedule(card, GOOD, card.lastReview! + DAY);
		assert.equal(JSON.stringify(card), before);
	});
});

describe("the long-run scheduling properties", () => {
	/** Advance one card through `n` Good ratings taken exactly at due time. */
	function goodRun(start: FSRSCard, n: number): FSRSCard {
		let card = start;
		let due = schedule(card, GOOD, card.lastReview ?? Date.UTC(2026, 0, 1));
		card = due.card;
		for (let i = 1; i < n; i++) {
			due = schedule(card, GOOD, card.lastReview! + due.interval * DAY);
			card = due.card;
		}
		return card;
	}

	it("stability is non-decreasing (strictly growing) across Good reviews at due time", () => {
		let card = schedule(newCard(), GOOD, Date.UTC(2026, 0, 1)).card;
		let result = schedule(card, GOOD, card.lastReview! + 10 / 1440 * DAY); // graduate
		card = result.card;
		const seen: number[] = [card.stability];
		for (let i = 0; i < 12; i++) {
			result = schedule(card, GOOD, card.lastReview! + result.interval * DAY);
			card = result.card;
			seen.push(card.stability);
		}
		for (let i = 1; i < seen.length; i++) {
			assert.ok(seen[i]! >= seen[i - 1]!, `S must never decrease: ${seen.join(", ")}`);
		}
		assert.ok(seen[seen.length - 1]! > seen[1]!, "a Good run grows stability overall");
	});

	it("dueAt moves monotonically forward for passing ratings taken at due time", () => {
		// Start graduated, then walk Good-at-due-time: each new interval
		// exceeds the previous one — strictly below the 36500-day cap, and
		// never backwards at it (the scheduler's ceiling).
		const first = schedule(newCard(), EASY, Date.UTC(2026, 0, 1));
		let interval = first.interval;
		let card = first.card;
		for (let i = 0; i < 10; i++) {
			const next = schedule(card, GOOD, card.lastReview! + interval * DAY);
			assert.ok(
				next.interval > interval || (interval === 36500 && next.interval === 36500),
				`interval must grow (or hold at the cap): ${interval} → ${next.interval}`,
			);
			interval = next.interval;
			card = next.card;
		}
	});

	it("a lapse drops the interval back, and recovery resumes growth", () => {
		const run = goodRun(schedule(newCard(), GOOD, Date.UTC(2026, 0, 1)).card, 6);
		const lapsed = schedule(run, AGAIN, run.lastReview! + 30 * DAY);
		assert.ok(lapsed.interval < 1, "a lapse re-enters the step ladder");
		const recovered = schedule(lapsed.card, GOOD, lapsed.card.lastReview! + lapsed.interval * DAY);
		assert.equal(recovered.card.state, "Review");
		assert.ok(recovered.interval >= 1);
		const next = schedule(recovered.card, GOOD, recovered.card.lastReview! + recovered.interval * DAY);
		assert.ok(next.interval > recovered.interval, "growth resumes after relearning");
	});

	it("same-session repeats barely move stability (R ≈ 1 → SInc ≈ 0), never backwards", () => {
		let card = schedule(newCard(), GOOD, Date.UTC(2026, 0, 1)).card;
		for (let i = 0; i < 5; i++) {
			const next = schedule(card, GOOD, card.lastReview! + 60_000); // a minute later
			assert.ok(next.card.stability >= card.stability, "a same-day repeat never shrinks S");
			card = next.card;
		}
	});
});

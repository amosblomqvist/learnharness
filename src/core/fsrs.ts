/**
 * FSRS-4.5 — the pure spaced-repetition scheduler (issue #33, retention).
 *
 * A zero-dependency implementation of the FSRS-4.5 memory model as published
 * by the open-spaced-repetition project (awesome-fsrs wiki, "The Algorithm"):
 * the 17 default weights, the power forgetting curve with DECAY = -0.5 and
 * FACTOR = 19/81 (so retrievability is exactly 0.9 one stability after the
 * last review), and the stability/difficulty update formulas. Parameters can
 * be overridden per call (an optimizer's weights drop in verbatim).
 *
 * Pure functions only — this is src/core (no IO, no React; the eslint zones
 * enforce it). Dates enter as epoch-ms numbers; nothing here reads a clock,
 * file, or network. The persistence-facing shapes (ISO strings, the
 * graph/reviews.json ledger) live in core/retention.ts, which converts at
 * the seam.
 *
 * Deliberate scope notes (documented in docs/retention.md):
 *  - FSRS-4.5 publishes no short-term/same-day formula (that arrived with
 *    FSRS-5); every rating here flows through the one formula set, with
 *    retrievability computed from real elapsed time. A same-session repeat
 *    therefore sees R ≈ 1 and moves stability barely at all — the model's
 *    own behavior at high R, not an invented rule.
 *  - The Learning/Relearning step intervals (1m/5m/10m) are an integration
 *    convention mirroring common FSRS deployments (Anki's default ladder);
 *    the published model fixes only the memory-state updates.
 */

// ─── the model's constants ───────────────────────────────────────────────────

/** The forgetting curve's decay exponent (FSRS-4.5). */
export const DECAY = -0.5;
/** The forgetting curve's factor: 19/81 makes R(t = S, S) exactly 0.9. */
export const FACTOR = 19 / 81;

/**
 * The FSRS-4.5 default weights (w[0..16], the open-spaced-repetition
 * optimizer's published defaults — verified against the awesome-fsrs wiki).
 * w[0..3] initial stability per rating, w[4]/w[5] initial difficulty,
 * w[6]/w[7] difficulty update, w[8..10] stability after recall,
 * w[11..14] stability after forget, w[15] hard penalty, w[16] easy bonus.
 */
export const FSRS_DEFAULT_PARAMETERS: readonly number[] = [
	0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246,
	1.587, 0.2272, 2.8755,
];

/** The requested retention intervals are scheduled for: retrievability
 * decays to this fraction at `dueAt` (0.9 is the model's canonical target). */
export const REQUEST_RETENTION = 0.9;

/** Difficulty lives in [1, 10] (the DSR model's range). */
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;

/** A stability is a positive day count; the interval cap mirrors the FSRS
 * deployments' maximum scheduling horizon (100 years, in days). */
const MAX_INTERVAL_DAYS = 36500;

/** The Learning/Relearning step ladder (days; fractional = sub-day). */
const STEP_AGAIN_DAYS = 1 / 1440; // 1 minute
const STEP_HARD_DAYS = 5 / 1440; // 5 minutes (the ladder's midpoint)
const STEP_GOOD_DAYS = 10 / 1440; // 10 minutes

// ─── the card ────────────────────────────────────────────────────────────────

/** The scheduler's four states (the classic FSRS/Anki lifecycle). */
export type FSRSState = "New" | "Learning" | "Review" | "Relearning";

/** The four answer ratings (Again = forgot; Hard/Good/Easy = recalled). */
export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;
export type Rating = typeof AGAIN | typeof HARD | typeof GOOD | typeof EASY;

export const isRating = (v: unknown): v is Rating =>
	v === AGAIN || v === HARD || v === GOOD || v === EASY;

/** One proposition's memory state — everything the scheduler needs. Pure
 * data; `lastReview` is epoch ms (undefined on a never-rated New card). */
export interface FSRSCard {
	state: FSRSState;
	/** D ∈ [1, 10] — how hard the memory is to reinforce. */
	difficulty: number;
	/** S in days — the interval at which retrievability reaches 0.9. */
	stability: number;
	/** How many ratings this card has received. */
	reps: number;
	/** How many times a Review-state card lapsed (was rated Again). */
	lapses: number;
	lastReview?: number;
}

/** A fresh card: never rated, no memory state yet. */
export function newCard(): FSRSCard {
	return { state: "New", difficulty: MAX_DIFFICULTY, stability: 0, reps: 0, lapses: 0 };
}

// ─── the forgetting curve ────────────────────────────────────────────────────

/** Elapsed days between two epoch-ms instants (never negative). */
function elapsedDays(card: FSRSCard, now: number): number {
	return card.lastReview === undefined ? 0 : Math.max(0, (now - card.lastReview) / 86_400_000);
}

/**
 * Retrievability — the predicted probability of recall `now`: the FSRS-4.5
 * power forgetting curve R(t, S) = (1 + FACTOR·t/S)^DECAY. 1 before any
 * review (a New card has nothing to forget yet); strictly decreasing in t
 * afterwards, exactly 0.9 one stability after the last review.
 */
export function retrievability(card: FSRSCard, now: number): number {
	if (card.lastReview === undefined || card.stability <= 0) return 1;
	const t = elapsedDays(card, now);
	return Math.pow(1 + (FACTOR * t) / card.stability, DECAY);
}

/** The interval (days) at which retrievability reaches `retention`:
 *  I(r, S) = (S/FACTOR)·(r^(1/DECAY) − 1) — S itself when r = 0.9. */
export function intervalForRetention(stability: number, retention: number): number {
	const days = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
	return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(days)));
}

// ─── the memory-state updates (the published FSRS-4.5 formulas) ─────────────

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Initial difficulty: D0(G) = w4 − e^(w5·(G−1)) + 1, clamped to [1, 10]. */
function initialDifficulty(w: readonly number[], rating: Rating): number {
	return clamp(w[4]! - Math.exp(w[5]! * (rating - 1)) + 1, MIN_DIFFICULTY, MAX_DIFFICULTY);
}

/** Difficulty update: linear ΔD = −w6·(G−3), then mean reversion toward
 *  D0(3) (FSRS-4.5's target) with weight w7 — the anti-ease-hell pull. */
function nextDifficulty(w: readonly number[], difficulty: number, rating: Rating): number {
	const dd = difficulty - w[6]! * (rating - 3);
	const reverted = w[7]! * initialDifficulty(w, GOOD) + (1 - w[7]!) * dd;
	return clamp(reverted, MIN_DIFFICULTY, MAX_DIFFICULTY);
}

/**
 * Stability after a successful review (Hard/Good/Easy):
 * S'r = S·(e^w8·(11−D)·S^(−w9)·(e^(w10·(1−R))−1)·hardPenalty·easyBonus + 1).
 */
function stabilityAfterRecall(
	w: readonly number[],
	difficulty: number,
	stability: number,
	rating: Rating,
	r: number,
): number {
	const hardPenalty = rating === HARD ? w[15]! : 1;
	const easyBonus = rating === EASY ? w[16]! : 1;
	const inc =
		Math.exp(w[8]!) *
		(11 - difficulty) *
		Math.pow(stability, -w[9]!) *
		(Math.exp(w[10]! * (1 - r)) - 1) *
		hardPenalty *
		easyBonus;
	return stability * (1 + inc);
}

/**
 * Stability after forgetting (post-lapse):
 * S'f = w11·D^(−w12)·((S+1)^w13 − 1)·e^(w14·(1−R)).
 */
function stabilityAfterForget(
	w: readonly number[],
	difficulty: number,
	stability: number,
	r: number,
): number {
	return w[11]! * Math.pow(difficulty, -w[12]!) * (Math.pow(stability + 1, w[13]!) - 1) * Math.exp(w[14]! * (1 - r));
}

// ─── schedule ────────────────────────────────────────────────────────────────

/** `schedule`'s result: the next card plus the interval (days — fractional
 * while the card sits in the Learning/Relearning step ladder). */
export interface ScheduleResult {
	card: FSRSCard;
	interval: number;
}

/**
 * Apply one rating to a card: the FSRS-4.5 memory-state updates plus the
 * state machine, purely — the input card is never mutated.
 *
 *   New      → any rating → Learning (S0(G), D0(G)); Easy graduates at once.
 *   Learning → Again/Hard stay in the ladder; Good/Easy graduate to Review.
 *   Review   → Again lapses (S'f, lapses+1 → Relearning); Hard/Good/Easy
 *              stay Review with S'r.
 *   Relearning → Again repeats the step; Hard/Good/Easy graduate to Review.
 *
 * While in Learning/Relearning the interval is the step ladder; from Review
 * (and on graduation) it is the time for retrievability to reach
 * REQUEST_RETENTION — with default retention 0.9 that is exactly the new
 * stability.
 */
export function schedule(
	card: FSRSCard,
	rating: Rating,
	now: number,
	params: readonly number[] = FSRS_DEFAULT_PARAMETERS,
): ScheduleResult {
	if (params.length !== 17) throw new Error(`FSRS-4.5 expects 17 parameters, got ${params.length}`);
	const w = params;
	const next: FSRSCard = { ...card, reps: card.reps + 1, lastReview: now };
	const r = retrievability(card, now);

	if (card.state === "New") {
		// First contact: the initial formulas seed both memory values.
		next.difficulty = initialDifficulty(w, rating);
		next.stability = w[rating - 1]!;
		if (rating === EASY) {
			next.state = "Review";
			return { card: next, interval: intervalForRetention(next.stability, REQUEST_RETENTION) };
		}
		next.state = "Learning";
		return { card: next, interval: learningStep(rating) };
	}

	// Every later rating updates both memory values through the formulas —
	// the forget path applies to Again, the recall path to the rest.
	if (rating === AGAIN) {
		next.difficulty = nextDifficulty(w, card.difficulty, rating);
		next.stability = stabilityAfterForget(w, next.difficulty, card.stability, r);
		if (card.state === "Review") next.lapses = card.lapses + 1;
		next.state = card.state === "Review" ? "Relearning" : card.state === "Relearning" ? "Relearning" : "Learning";
		return { card: next, interval: STEP_AGAIN_DAYS };
	}

	next.difficulty = nextDifficulty(w, card.difficulty, rating);
	next.stability = Math.max(
		card.stability,
		stabilityAfterRecall(w, next.difficulty, card.stability, rating, r),
	);
	if (card.state === "Review") {
		next.state = "Review";
		return { card: next, interval: intervalForRetention(next.stability, REQUEST_RETENTION) };
	}
	// Learning/Relearning: Hard stays in the ladder; Good/Easy graduate.
	if (rating === HARD) {
		next.state = card.state;
		return { card: next, interval: STEP_HARD_DAYS };
	}
	next.state = "Review";
	return { card: next, interval: intervalForRetention(next.stability, REQUEST_RETENTION) };
}

/** The Learning/Relearning step interval for one rating (days). */
function learningStep(rating: Rating): number {
	return rating === AGAIN ? STEP_AGAIN_DAYS : rating === HARD ? STEP_HARD_DAYS : STEP_GOOD_DAYS;
}

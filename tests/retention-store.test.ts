/**
 * ReviewStore roundtrip (issue #33, retention): the fs adapter for
 * graph/reviews.json under an isolated temp LH_DATA_DIR (the
 * store-writes-atomic idiom — env before any config-loading import).
 * Covers write→read identity, the tolerant first-boot/corrupt reads, the
 * lazy graph-family format stamp, and the pure conclude-capture fold the
 * store persists.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GOOD, newCard, schedule } from "../src/core/fsrs.ts";
import { applyConcludeOutcome } from "../src/core/retention.ts";
import type { ReviewEntry } from "../src/core/retention.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retention-store-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");

const config = await import("../config.ts");
const { reviewStore } = await import("../src/store/reviews.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = new Date("2026-11-01T12:00:00.000Z");
/** A realistic Review-state entry via the real scheduler. */
function entry(dueInDays: number, session: string): ReviewEntry {
	const { card, interval } = schedule(newCard(), GOOD, NOW.getTime());
	return {
		state: card.state,
		difficulty: card.difficulty,
		stability: card.stability,
		reps: card.reps,
		lapses: card.lapses,
		lastReviewAt: new Date(card.lastReview!).toISOString(),
		dueAt: new Date(card.lastReview! + (dueInDays ?? interval) * DAY).toISOString(),
		updatedInSession: session,
	};
}

describe("review ledger store (graph/reviews.json)", () => {
	it("an absent file reads as {} — the first-boot ledger", () => {
		assert.deepEqual(reviewStore.readReviews(), {});
	});

	it("writes and reads back whole-ledger (roundtrip identity)", () => {
		const ledger = { n_alpha: entry(3, "chat_1"), n_beta: entry(30, "chat_2") };
		reviewStore.writeReviews(ledger);
		assert.deepEqual(reviewStore.readReviews(), ledger);
		// The file exists where the brief pins it, and the family stamp rode along.
		assert.ok(fs.existsSync(config.REVIEWS_FILE));
		assert.equal(path.dirname(config.REVIEWS_FILE), config.PATHS.graph);
		const stamp = JSON.parse(fs.readFileSync(config.GRAPH_FORMAT_FILE, "utf-8")) as { version: number };
		assert.equal(stamp.version, 1);
	});

	it("a corrupt file reads as {} and invalid entries are skipped, never guessed at", () => {
		fs.mkdirSync(config.PATHS.graph, { recursive: true });
		fs.writeFileSync(config.REVIEWS_FILE, "{not json", "utf-8");
		assert.deepEqual(reviewStore.readReviews(), {});
		const good = entry(1, "chat_1");
		fs.writeFileSync(
			config.REVIEWS_FILE,
			JSON.stringify({ n_good: good, n_bad: { state: "Review" }, n_worse: "nope" }, null, "\t"),
			"utf-8",
		);
		assert.deepEqual(reviewStore.readReviews(), { n_good: good });
	});

	it("the pure capture fold persists through the store (read → fold → write)", () => {
		const picks = new Set(["n_alpha", "n_new"]);
		const reviews = reviewStore.readReviews();
		const next = applyConcludeOutcome(reviews, picks, ["n_alpha", "n_new", "n_unpicked"], "solved", NOW, "chat_3");
		assert.notEqual(next, reviews, "a capture with picked targets changes the ledger");
		reviewStore.writeReviews(next);
		const read = reviewStore.readReviews();
		assert.ok(read.n_alpha, "the existing entry was rescheduled");
		assert.ok(read.n_new, "a never-scheduled pick gained an entry");
		assert.equal(read.n_unpicked, undefined, "an unpicked target is out of scope");
		assert.equal(read.n_alpha!.updatedInSession, "chat_3");
		// A dismissed outcome or an untagged problem writes nothing (identity).
		assert.equal(applyConcludeOutcome(read, picks, ["n_alpha"], "dismissed", NOW, "chat_3"), read);
		assert.equal(applyConcludeOutcome(read, picks, [], "solved", NOW, "chat_3"), read);
	});
});

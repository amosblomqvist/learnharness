import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySm2, isDue, isMastered, reviewQueue, SM2_MIN_EASE, type ReviewCard } from "../src/core/course.ts";

const NOW = new Date("2026-03-01T00:00:00.000Z");

describe("SM-2 review scheduling", () => {
	it("follows the published interval steps and ease update", () => {
		let card: ReviewCard | null = null;
		card = applySm2(card, 5, NOW);
		assert.equal(card.intervalDays, 1);
		assert.equal(card.repetitions, 1);
		assert.equal(card.ease, 2.6);
		assert.equal(card.due, "2026-03-02");
		card = applySm2(card, 5, NOW);
		assert.equal(card.intervalDays, 6);
		assert.equal(card.repetitions, 2);
		assert.equal(card.ease, 2.7);
		card = applySm2(card, 5, NOW);
		assert.equal(card.intervalDays, 16);
		assert.equal(card.repetitions, 3);
		assert.equal(isMastered(card, "2026-03-01"), false);
		card = applySm2(card, 5, NOW);
		assert.equal(card.intervalDays, 45);
		assert.equal(isMastered(card, "2026-03-01"), true);
		assert.equal(isDue(card, card.due), true);
		assert.equal(isMastered(card, card.due), false);
	});

	it("resets a miss and does not let ease fall below 1.3", () => {
		let card: ReviewCard | null = applySm2(null, 5, NOW);
		card = applySm2(card, 5, NOW);
		card = applySm2(card, 0, NOW);
		assert.equal(card.repetitions, 0);
		assert.equal(card.intervalDays, 1);
		assert.ok(card.ease >= SM2_MIN_EASE);
		let floor = card;
		for (let i = 0; i < 8; i += 1) floor = applySm2(floor, 0, NOW);
		assert.equal(floor.ease, SM2_MIN_EASE);
	});

	it("lists due chapter and heading reviews, and skips removed chapters", () => {
		const due: ReviewCard = { ease: 2.5, intervalDays: 1, repetitions: 1, due: "2026-03-01", lastReviewed: null, lastGrade: 4 };
		const later: ReviewCard = { ...due, due: "2026-04-01" };
		const queue = reviewQueue([
			{
				id: "course",
				title: "Course",
				chapters: [
					{
						id: "n-02",
						title: "Lines",
						order: 2,
						present: true,
						card: later,
						concepts: [{ id: "arrival", title: "Arrival", retired: false, card: due }],
					},
					{
						id: "n-01",
						title: "Boxes",
						order: 1,
						present: false,
						card: due,
						concepts: [],
					},
					{
						id: "n-03",
						title: "Boxes",
						order: 3,
						present: true,
						card: due,
						concepts: [{ id: "old", title: "Old", retired: true, card: due }],
					},
				],
			},
		], "2026-03-01");
		assert.deepEqual(queue.map((item) => [item.chapterId, item.conceptId]), [
			["n-02", "arrival"],
			["n-03", null],
		]);
	});
});

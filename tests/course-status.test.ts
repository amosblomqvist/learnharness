import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chapterStatus, conceptStatus, type ReviewCard } from "../src/core/course.ts";

const today = "2026-03-15";
const mastered: ReviewCard = {
	ease: 2.6,
	intervalDays: 21,
	repetitions: 3,
	due: "2026-04-20",
	lastReviewed: "2026-03-01T00:00:00.000Z",
	lastGrade: 5,
};
const due: ReviewCard = { ...mastered, due: "2026-03-15" };

describe("chapter status", () => {
	const base = { teachSessions: 0, practiceSessions: 0, card: null, concepts: [], today };

	it("stays not started until the learner has a session or a review card", () => {
		assert.equal(chapterStatus(base), "not_started");
		assert.equal(conceptStatus(null, today), "not_started");
	});

	it("becomes learning from a teaching or practice session", () => {
		assert.equal(chapterStatus({ ...base, teachSessions: 1 }), "learning");
		assert.equal(chapterStatus({ ...base, practiceSessions: 1 }), "learning");
	});

	it("prefers review due over mastered, including a due heading", () => {
		assert.equal(chapterStatus({ ...base, card: mastered }), "mastered");
		assert.equal(chapterStatus({ ...base, card: due }), "review_due");
		assert.equal(chapterStatus({
			...base,
			card: mastered,
			concepts: [{ retired: false, card: due }],
		}), "review_due");
		assert.equal(conceptStatus(due, today), "review_due");
	});

	it("does not let a retired heading or an unreviewed heading block mastery", () => {
		assert.equal(chapterStatus({
			...base,
			card: mastered,
			concepts: [{ retired: true, card: due }, { retired: false, card: null }],
		}), "mastered");
		assert.equal(chapterStatus({
			...base,
			card: mastered,
			concepts: [{ retired: false, card: { ...mastered, lastGrade: 3 } }],
		}), "learning");
	});
});

/**
 * SCHEDULED PRACTICE — the pure scheduler (core/review.ts) and the review
 * settings section: the grading table, FSRS replay over the log, the
 * premise-first introduction order, the 4 AM day and its new-item
 * allowance, and the session's due-first picks.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Rating } from "ts-fsrs";

import { formatReviewBrief, ratingOf, reviewBriefOf, reviewDayStart, reviewQueue } from "../src/core/review.ts";
import type { ReviewEvent, ReviewOutcome, ReviewRung } from "../src/core/contracts/review.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseReviewSettingsBody } from "../src/server/settings-body.ts";

// Local-time dates: the day boundary is the server's local 4 AM.
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const node = (id: string, createdDay: number) => ({ id, createdAt: local(createdDay, 12).toISOString() });

let seq = 0;
function review(targets: string[], at: Date, outcome: ReviewOutcome = "solved", rung: ReviewRung = null): ReviewEvent {
	seq++;
	return { id: `chat:p${seq}`, chatId: "chat", problemCallId: `p${seq}`, at: at.toISOString(), targets, outcome, rung };
}

describe("ratingOf — the grading table", () => {
	const table: [ReviewOutcome, ReviewRung, Rating][] = [
		["solved", null, Rating.Good],
		["solved", "R0", Rating.Good],
		["solved", "R1", Rating.Good],
		["solved", "R2", Rating.Hard],
		["solved", "R3", Rating.Again],
		["solved", "R5", Rating.Again],
		["solvedWithHints", null, Rating.Hard],
		["solvedWithHints", "R0", Rating.Hard],
		["solvedWithHints", "R2", Rating.Hard],
		["solvedWithHints", "R3", Rating.Again],
		["solvedWithHints", "R4", Rating.Again],
		["movedOn", null, Rating.Again],
		["surrendered", "R1", Rating.Again],
		["dismissed", null, Rating.Again],
	];
	for (const [outcome, rung, expected] of table) {
		it(`${outcome} + ${rung ?? "no rung"} → ${Rating[expected]}`, () => {
			assert.equal(ratingOf(outcome, rung), expected);
		});
	}
	it("never assigns Easy", () => {
		for (const [outcome, rung] of table) assert.notEqual(ratingOf(outcome, rung), Rating.Easy);
	});
});

describe("reviewDayStart — the 4 AM rollover", () => {
	it("before 4 AM belongs to the previous day", () => {
		assert.equal(reviewDayStart(local(2, 3)).getTime(), local(1, 4).getTime());
	});
	it("at and after 4 AM belongs to the same day", () => {
		assert.equal(reviewDayStart(local(2, 4)).getTime(), local(2, 4).getTime());
		assert.equal(reviewDayStart(local(2, 23)).getTime(), local(2, 4).getTime());
	});
});

describe("reviewQueue", () => {
	const base = { chains: [], newPerDay: 10 };

	it("new propositions: premises before their conclusions, then oldest first", () => {
		// n_old concludes from n_new — the premise comes first despite its age.
		const queue = reviewQueue({
			...base,
			reviews: [],
			nodes: [node("n_old", 1), node("n_new", 3), node("n_mid", 2)],
			chains: [{ premises: ["n_new"], conclusion: "n_old" }],
			now: local(10, 12),
		});
		assert.deepEqual(queue.newAvailable, ["n_mid", "n_new", "n_old"]);
		assert.deepEqual(queue.due, []);
	});

	it("a premise cycle releases its oldest member instead of stalling", () => {
		const queue = reviewQueue({
			...base,
			reviews: [],
			nodes: [node("n_a", 1), node("n_b", 2)],
			chains: [{ premises: ["n_a"], conclusion: "n_b" }, { premises: ["n_b"], conclusion: "n_a" }],
			now: local(10, 12),
		});
		assert.deepEqual(queue.newAvailable, ["n_a", "n_b"]);
	});

	it("the daily allowance counts propositions first reviewed since today's 4 AM", () => {
		const nodes = [node("n_1", 1), node("n_2", 1), node("n_3", 1), node("n_4", 1)];
		const reviews = [review(["n_1"], local(2, 5))]; // first review: day 2, 5 AM
		// Day 3, 3 AM is still day 2 — n_1 used one of two slots.
		const sameDay = reviewQueue({ ...base, newPerDay: 2, nodes, reviews, now: local(3, 3) });
		assert.deepEqual(sameDay.newAvailable, ["n_2"]);
		// Day 3, 5 AM is a fresh day — both slots are open again.
		const nextDay = reviewQueue({ ...base, newPerDay: 2, nodes, reviews, now: local(3, 5) });
		assert.deepEqual(nextDay.newAvailable, ["n_2", "n_3"]);
	});

	it("newPerDay 0 pauses new material", () => {
		const queue = reviewQueue({ ...base, newPerDay: 0, reviews: [], nodes: [node("n_1", 1)], now: local(3, 12) });
		assert.deepEqual(queue.newAvailable, []);
		assert.deepEqual(queue.picks, []);
	});

	it("a fresh success is not due; an old one is; a recent miss comes back within the day", () => {
		const nodes = [node("n_fresh", 1), node("n_old", 1), node("n_miss", 1)];
		const now = local(20, 12);
		const queue = reviewQueue({
			...base,
			nodes,
			reviews: [
				review(["n_fresh"], local(20, 11, 59)),
				review(["n_old"], local(1, 12)),
				review(["n_miss"], local(20, 10), "surrendered", "R5"),
			],
			now,
		});
		assert.deepEqual(new Set(queue.due), new Set(["n_old", "n_miss"]));
		assert.ok(!queue.newAvailable.includes("n_fresh"), "a practiced proposition is never new");
	});

	it("most overdue first", () => {
		const queue = reviewQueue({
			...base,
			nodes: [node("n_a", 1), node("n_b", 1)],
			reviews: [review(["n_b"], local(1, 12)), review(["n_a"], local(5, 12))],
			now: local(25, 12),
		});
		assert.deepEqual(queue.due, ["n_b", "n_a"]);
	});

	it("a multi-target review schedules every target", () => {
		const queue = reviewQueue({
			...base,
			nodes: [node("n_a", 1), node("n_b", 1)],
			reviews: [review(["n_a", "n_b"], local(1, 12))],
			now: local(25, 12),
		});
		assert.deepEqual(new Set(queue.due), new Set(["n_a", "n_b"]));
	});

	it("reviews of deleted propositions are skipped and spend no allowance", () => {
		const queue = reviewQueue({
			...base,
			newPerDay: 1,
			nodes: [node("n_live", 1)],
			reviews: [review(["n_gone"], local(3, 10))],
			now: local(3, 12),
		});
		assert.deepEqual(queue.due, []);
		assert.deepEqual(queue.newAvailable, ["n_live"]);
	});

	it("picks: due first, then new, capped at the session size", () => {
		const nodes = Array.from({ length: 12 }, (_, i) => node(`n_${String(i).padStart(2, "0")}`, 1));
		const reviews = nodes.slice(0, 5).map((n) => review([n.id], local(1, 12)));
		const queue = reviewQueue({ ...base, nodes, reviews, now: local(25, 12) });
		assert.equal(queue.due.length, 5);
		assert.equal(queue.picks.length, 8);
		assert.deepEqual(queue.picks.slice(0, 5), queue.due);
		assert.deepEqual(queue.picks.slice(5), queue.newAvailable.slice(0, 3));
	});

	it("is deterministic (no fuzz)", () => {
		const input = {
			...base,
			nodes: [node("n_a", 1), node("n_b", 1)],
			reviews: [review(["n_a"], local(1, 12)), review(["n_a"], local(2, 12), "solvedWithHints", "R1")],
			now: local(9, 12),
		};
		assert.deepEqual(reviewQueue(input), reviewQueue(input));
	});
});

describe("reviewBriefOf — the history brief", () => {
	const facts = (r: ReviewEvent, extra: Partial<ReviewEvent>): ReviewEvent => ({ ...r, ...extra });

	it("a never-practiced pick is new", () => {
		const [entry] = reviewBriefOf({ reviews: [], pickIds: ["n_a"], now: local(9, 12) });
		assert.deepEqual(entry, {
			id: "n_a",
			status: { kind: "new" },
			reviews: 0,
			misses: 0,
			highestCleanMode: null,
			last: null,
			recentSurfaces: [],
		});
		assert.deepEqual(formatReviewBrief([entry!]), ["- [n_a] new — never practiced"]);
	});

	it("counts reviews and misses, keeps pick order, and ignores other targets", () => {
		const reviews = [
			review(["n_a"], local(1, 12)),
			review(["n_a", "n_z"], local(2, 12), "surrendered", "R5"),
			review(["n_b"], local(3, 12)),
		];
		const entries = reviewBriefOf({ reviews, pickIds: ["n_b", "n_a"], now: local(4, 12) });
		assert.deepEqual(entries.map((e) => [e.id, e.reviews, e.misses]), [["n_b", 1, 0], ["n_a", 2, 1]]);
	});

	it("the highest clean mode needs a solve at R1 or below", () => {
		const reviews = [
			facts(review(["n_a"], local(1, 12), "solved", "R0"), { mode: "recall" }),
			facts(review(["n_a"], local(2, 12), "solvedWithHints", "R1"), { mode: "discrimination" }),
			facts(review(["n_a"], local(3, 12), "solved", "R2"), { mode: "composition" }),
			facts(review(["n_a"], local(4, 12), "surrendered", null), { mode: "composition" }),
		];
		const [entry] = reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(5, 12) });
		assert.equal(entry!.highestCleanMode, "discrimination");
	});

	it("overdue vs scheduled follows the FSRS replay; days are whole", () => {
		const reviews = [review(["n_a"], local(1, 12))];
		const [soon] = reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(1, 12, 1) }); // short-term step: minutes, not days
		assert.deepEqual(soon!.status, { kind: "scheduled", days: 0 });
		assert.match(formatReviewBrief([soon!])[0]!, / due within a day · /);
		const [late] = reviewBriefOf({ reviews, pickIds: ["n_a"], now: new Date(2026, 11, 30, 12) });
		assert.equal(late!.status.kind, "overdue");
		assert.ok(late!.status.kind === "overdue" && late!.status.days > 0);
	});

	it("lists the newest surfaces first, at most three", () => {
		const reviews = ["s1", "s2", "s3", "s4"].map((surface, i) => facts(review(["n_a"], local(1 + i, 12)), { surface }));
		reviews.push(review(["n_a"], local(6, 12))); // an old-format line: no surface
		const [entry] = reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(7, 12) });
		assert.deepEqual(entry!.recentSurfaces, ["s4", "s3", "s2"]);
	});

	it("the last review carries only the facts it recorded", () => {
		const [entry] = reviewBriefOf({ reviews: [review(["n_a"], local(1, 12), "movedOn", "R3")], pickIds: ["n_a"], now: local(3, 13) });
		assert.deepEqual(entry!.last, { outcome: "movedOn", rung: "R3", daysAgo: 2 });
	});

	it("formats one line per pick, ids first", () => {
		const reviews = [
			facts(review(["n_a"], local(1, 12), "solved", null), { mode: "recall", missClass: null, surface: "a ladder" }),
			facts(review(["n_a"], local(2, 12), "surrendered", "R4"), { mode: "discrimination", missClass: "discrimination", surface: "a ramp" }),
		];
		const [line] = formatReviewBrief(reviewBriefOf({ reviews, pickIds: ["n_a"], now: local(2, 12) }));
		assert.match(line!, /^- \[n_a\] (due now|overdue \d+ days?|due within a day|due in \d+ days?) · 2 reviews, 1 miss · highest clean mode: recall · /);
		assert.ok(line!.includes("last (today): surrendered, rung R4, mode discrimination, miss discrimination"));
		assert.ok(line!.endsWith('recent surfaces: "a ramp"; "a ladder"'));
	});
});

describe("the review settings section", () => {
	it("resolves to the factory 10/day", () => {
		assert.equal(resolveSettings(null).review.newPerDay, 10);
		assert.equal(resolveSettings({ version: 1, review: { newPerDay: 3 } }).review.newPerDay, 3);
	});

	it("the read side floors and drops invalid values", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, review: { newPerDay: 4.7 } })?.review, { newPerDay: 4 });
		assert.deepEqual(sanitizeUserSettings({ version: 1, review: { newPerDay: -1 } })?.review, {});
		assert.deepEqual(sanitizeUserSettings({ version: 1, review: { newPerDay: "5" } })?.review, {});
	});

	it("the write side accepts whole numbers ≥ 0 and rejects the rest", () => {
		assert.deepEqual(parseReviewSettingsBody({ newPerDay: 0 }), { ok: true, settings: { newPerDay: 0 } });
		assert.deepEqual(parseReviewSettingsBody({}), { ok: true, settings: {} });
		assert.equal(parseReviewSettingsBody({ newPerDay: 2.5 }).ok, false);
		assert.equal(parseReviewSettingsBody({ newPerDay: -1 }).ok, false);
		assert.equal(parseReviewSettingsBody(null).ok, false);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dependentsOf, lessonGraphProblems, lessonSlug, topoOrder, wouldCycle } from "../src/core/course-graph.ts";
import { lesson } from "./helpers/course-fixtures.ts";

describe("course lesson graph", () => {
	it("accepts a valid DAG", () => {
		const ls = [lesson({ id: "a" }), lesson({ id: "b", prerequisites: ["a"] }), lesson({ id: "c", prerequisites: ["a", "b"] })];
		assert.deepEqual(lessonGraphProblems(ls), []);
	});

	it("reports duplicate ids, self-loops and unknown prerequisites", () => {
		const problems = lessonGraphProblems([lesson({ id: "a" }), lesson({ id: "a" }), lesson({ id: "b", prerequisites: ["b", "zz"] })]);
		assert.ok(problems.some((p) => p.includes('Duplicate lesson id "a"')));
		assert.ok(problems.some((p) => p.includes("lists itself")));
		assert.ok(problems.some((p) => p.includes('unknown prerequisite "zz"')));
	});

	it("reports a cycle with its path", () => {
		const problems = lessonGraphProblems([lesson({ id: "a", prerequisites: ["c"] }), lesson({ id: "b", prerequisites: ["a"] }), lesson({ id: "c", prerequisites: ["b"] })]);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /cycle: .*→/);
	});

	it("wouldCycle detects transitive back-edges and self-loops", () => {
		const ls = [lesson({ id: "a" }), lesson({ id: "b", prerequisites: ["a"] }), lesson({ id: "c", prerequisites: ["b"] })];
		assert.equal(wouldCycle(ls, "c", "a"), true, "a ← c would close a→b→c→a");
		assert.equal(wouldCycle(ls, "a", "c"), false);
		assert.equal(wouldCycle(ls, "a", "a"), true);
	});

	it("topoOrder respects prerequisites, then target date, then title", () => {
		const ls = [
			lesson({ id: "late", targetDate: "2026-11-20" }),
			lesson({ id: "early", targetDate: "2026-11-01" }),
			lesson({ id: "dep", targetDate: "2026-10-31", prerequisites: ["late"] }),
		];
		assert.deepEqual(topoOrder(ls).map((l) => l.id), ["early", "late", "dep"]);
	});

	it("dependentsOf and lessonSlug", () => {
		const ls = [lesson({ id: "a" }), lesson({ id: "b", prerequisites: ["a"] })];
		assert.deepEqual(dependentsOf(ls, "a"), ["b"]);
		assert.equal(lessonSlug("Chain Rule: Intuition!", new Set()), "chain-rule-intuition");
		assert.equal(lessonSlug("A", new Set(["a", "a-2"])), "a-3");
		assert.equal(lessonSlug("!!!", new Set()), "lesson");
	});
});

/**
 * Legend/filters predicate tests — the pure half of the graph-view filters
 * panel (isNodeVisible); the sigma reducers just consume its verdict.
 * Unicode folding matches hamza, tashkeel and niqqud on both sides.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayCostTotals, isNodeVisible } from "../components/graph-view.tsx";

const node = {
	name: "Money multiplier",
	statement: "The maximum ratio of broad money a bank can create from each unit of base money.",
};

describe("isNodeVisible (search predicate)", () => {
	it("matches hamza and tashkeel in names and statements on both sides", () => {
		const marked = { name: "أَحْمَدُ", statement: "إِنَّ الْمُشْتَقَّةَ مُهِمَّةٌ" };
		assert.equal(isNodeVisible(marked, "احمد"), true);
		assert.equal(isNodeVisible(marked, "أحْمَد"), true);
		assert.equal(isNodeVisible(marked, "ان المشتقة"), true);
		assert.equal(isNodeVisible({ name: "احمد", statement: "ان المشتقة مهمة" }, "إِنَّ الْمُشْتَقَّةَ"), true);
		assert.equal(isNodeVisible(marked, "تكامل"), false);
	});

	it("folds Hebrew niqqud without a language-specific filter path", () => {
		assert.equal(isNodeVisible({ name: "שָׁלוֹם", statement: "" }, "שלום"), true);
	});

	it("is visible with an empty query", () => {
		assert.equal(isNodeVisible(node, ""), true);
	});

	it("search matches the statement case-insensitively", () => {
		assert.equal(isNodeVisible(node, "MONEY multiplier"), true);
	});

	it("search matches the statement when the name does not", () => {
		assert.equal(isNodeVisible(node, "MAXIMUM ratio"), true);
		assert.equal(isNodeVisible(node, " velocity"), false);
	});

	it("search matches the name when the statement does not", () => {
		assert.equal(isNodeVisible(node, "money MULTIPLIER"), true);
		assert.equal(isNodeVisible(node, " banking"), false);
	});

	it("whitespace-only query is no filter", () => {
		assert.equal(isNodeVisible(node, "   "), true);
	});

	it("keeps voiced kana apart and finds a math letter by its plain letter", () => {
		assert.equal(isNodeVisible({ name: "バス", statement: "" }, "ハス"), false);
		assert.equal(isNodeVisible({ name: "バス", statement: "" }, "ﾊﾞｽ"), true);
		assert.equal(isNodeVisible({ name: "x ∈ ℝ", statement: "" }, "r"), true);
	});


});

describe("displayCostTotals (naming-free cost fold)", () => {
	const stage = (dollars: number, unpricedRuns = 0) => ({
		runs: dollars > 0 ? 1 : 0,
		dollars,
		unpricedRuns,
		tokens: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		},
	});
	const costs = {
		stages: {
			extraction: stage(1.25, 1),
			audit: stage(0.75),
			naming: stage(9.99, 2), // dead channel — must never reach the display
		},
	} as const;

	it("sums the live stages only — the dead namer's spend is invisible", () => {
		assert.equal(displayCostTotals(costs).totalDollars, 2);
	});

	it("unpriced counts fold the same two stages", () => {
		assert.equal(displayCostTotals(costs).unpricedRuns, 1);
	});
});

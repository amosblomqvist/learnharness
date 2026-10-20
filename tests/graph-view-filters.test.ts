/**
 * Legend/filters predicate tests — the pure half of the graph-view filters
 * panel (isNodeVisible); the sigma reducers just consume its verdict.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayCostTotals, isNodeVisible } from "../components/graph-view.tsx";

const node = {
	name: "Money multiplier",
	statement: "The maximum ratio of broad money a bank can create from each unit of base money.",
};

describe("isNodeVisible (search predicate)", () => {
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


});

describe("displayCostTotals (naming-free cost fold)", () => {
	const stage = (
		dollars: number | null,
		unpricedRuns = 0,
		coverage: "complete" | "partial" | "unknown" = dollars === null ? "unknown" : unpricedRuns > 0 ? "partial" : "complete",
	) => ({
		runs: unpricedRuns > 0 || dollars !== null ? 1 : 0,
		dollars,
		coverage,
		pricedRuns: dollars === null ? 0 : 1,
		unpricedRuns,
		missingUsageRuns: 0,
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

	it("a priced subtotal with an unpriced stage is partial, never a complete total", () => {
		assert.equal(displayCostTotals(costs).coverage, "partial");
	});

	it("nothing priced anywhere: the total is ABSENT, never $0", () => {
		const unpriced = {
			stages: {
				extraction: stage(null, 1),
				audit: stage(null, 1),
			},
		} as const;
		const totals = displayCostTotals(unpriced);
		assert.equal(totals.totalDollars, null);
		assert.equal(totals.coverage, "unknown");
		assert.equal(totals.unpricedRuns, 2);
	});

	it("a stage that never ran contributes nothing and does not mark the total partial", () => {
		const oneStage = {
			stages: {
				extraction: stage(0.5),
				audit: stage(null, 0, "complete"),
			},
		} as const;
		assert.equal(displayCostTotals(oneStage).totalDollars, 0.5);
		assert.equal(displayCostTotals(oneStage).coverage, "complete");
		const noRuns = {
			stages: { extraction: stage(null, 0, "complete"), audit: stage(null, 0, "complete") },
		} as const;
		assert.equal(displayCostTotals(noRuns).totalDollars, null);
		assert.equal(displayCostTotals(noRuns).coverage, "unknown");
	});
});

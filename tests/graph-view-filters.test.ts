/**
 * Legend/filters predicate tests — the pure half of the graph-view filters
 * panel (isNodeVisible); the sigma reducers just consume its verdict.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayCostTotals, graphVisibleIds, isNodeVisible, nextGraphStatusState } from "../components/graph-view.tsx";
import { graphFolderVisibleIds, type GraphNode, type SourceOrganization } from "../src/core/index.ts";
import { deriveView } from "../src/core/graph.ts";

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

it("combined search and folder scope hide every segment if a premise or conclusion is hidden", () => {
	const prop = (id: string, name: string): GraphNode => ({
		id, name, statement: name, aliases: [], createdAt: "now", provenance: [],
	});
	const propositions = [prop("p1", "Physics premise"), prop("p2", "Physics evidence"), prop("c", "Physics outcome")];
	// Only the first premise matches 'premise'; only the conclusion matches 'outcome'.
	const view = deriveView({ nodes: propositions, chains: [{ id: "arg_test", premises: ["p1", "p2"], conclusion: "c", createdAt: "now", provenance: [] }] });
	const organization: SourceOrganization = {
		version: 1, folders: [{ id: "f", name: "Folder", parentId: null, createdAt: "now" }], placements: { chat: { folderId: "f" } },
	};
	const folder = graphFolderVisibleIds({ organization, selected: new Set(["f"]), listed: new Set(["f"]),
		propositionIds: ["p1", "p2", "c"], nodeSources: { p1: ["chat"], p2: ["chat"], c: ["chat"] }, impLinks: view.impLinks });
	const edges = (ids: Set<string>) => view.edges.filter(({ from, to }) => ids.has(from) && ids.has(to));
	for (const [query, visible] of [["premise", "p1"], ["outcome", "c"]] as const) {
		assert.ok(graphVisibleIds(view, query, null).has("arg_test"), "search alone retains its behavior");
		const result = graphVisibleIds(view, query, folder);
		assert.deepEqual([...result], [visible]);
		assert.deepEqual(edges(result), []);
	}
	assert.deepEqual(edges(graphVisibleIds(view, "Physics", folder)), view.edges);
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

describe("nextGraphStatusState (status + graphRevision refresh transitions)", () => {
	const row = (id: string) => ({ id, chatId: id.split("#")[0]!, title: id, phase: "extracting", startedAt: 1 });

	it("initial mount seeds lastRevision without triggering an extra refresh", () => {
		const next = nextGraphStatusState(
			{ rowIds: new Set(), lastRevision: null },
			{ runs: [], graphRevision: 1000 },
		);
		assert.equal(next.shouldRefresh, false);
		assert.equal(next.lastRevision, 1000);
		assert.equal(next.rowIds.size, 0);
	});

	it("steady state with unchanged revision does not loop", () => {
		const next = nextGraphStatusState(
			{ rowIds: new Set(), lastRevision: 1000 },
			{ runs: [], graphRevision: 1000 },
		);
		assert.equal(next.shouldRefresh, false);
		assert.equal(next.lastRevision, 1000);
	});

	it("refreshes when graphRevision moves even if runs stayed empty (fast unseen extraction)", () => {
		const next = nextGraphStatusState(
			{ rowIds: new Set(), lastRevision: 1000 },
			{ runs: [], graphRevision: 2000 },
		);
		assert.equal(next.shouldRefresh, true);
		assert.equal(next.lastRevision, 2000);
	});

	it("refreshes when a run row disappears even if graphRevision stayed unchanged", () => {
		const next = nextGraphStatusState(
			{ rowIds: new Set(["chat_1#1"]), lastRevision: 1000 },
			{ runs: [], graphRevision: 1000 },
		);
		assert.equal(next.shouldRefresh, true);
		assert.equal(next.rowIds.size, 0);
	});

	it("preserves lastRevision when payload omits graphRevision and still tracks row disappearance", () => {
		const active = nextGraphStatusState(
			{ rowIds: new Set(), lastRevision: 1500 },
			{ runs: [row("chat_1")] },
		);
		assert.equal(active.shouldRefresh, false);
		assert.equal(active.lastRevision, 1500);
		assert.deepEqual([...active.rowIds], ["chat_1"]);

		const done = nextGraphStatusState(active, { runs: [] });
		assert.equal(done.shouldRefresh, true);
		assert.equal(done.lastRevision, 1500);
	});
});

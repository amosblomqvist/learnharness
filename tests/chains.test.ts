import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	chainsForSelection,
	formatChainLine,
	resolveTargetId,
} from "../src/core/chains.ts";

describe("chainsForSelection", () => {
	it("returns empty array when there are no nodes", () => {
		assert.deepEqual(chainsForSelection([], []), []);
		assert.deepEqual(
			chainsForSelection([], [{ id: "arg1", premises: ["p1"], conclusion: "c1" }]),
			[],
		);
	});

	it("turns edge-less nodes into singleton chains", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }];
		const result = chainsForSelection(nodes, []);
		assert.deepEqual(result, [
			{ id: "n1", premises: [], conclusion: "n1" },
			{ id: "n2", premises: [], conclusion: "n2" },
		]);
	});

	it("includes a chain when its conclusion and all premises are selected", () => {
		const nodes = [{ id: "p1" }, { id: "p2" }, { id: "c1" }];
		const chains = [{ id: "arg1", premises: ["p2", "p1"], conclusion: "c1" }];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "arg1", premises: ["p1", "p2"], conclusion: "c1" },
		]);
	});

	it("does not create a singleton for premise nodes of an included chain", () => {
		const nodes = [{ id: "p1" }, { id: "c1" }];
		const chains = [{ id: "arg1", premises: ["p1"], conclusion: "c1" }];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "arg1", premises: ["p1"], conclusion: "c1" },
		]);
	});

	it("excludes a chain if conclusion is not selected and turns selected premises into singletons", () => {
		const nodes = [{ id: "p1" }, { id: "p2" }];
		const chains = [{ id: "arg1", premises: ["p1", "p2"], conclusion: "c1" }];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "p1", premises: [], conclusion: "p1" },
			{ id: "p2", premises: [], conclusion: "p2" },
		]);
	});

	it("excludes a chain if any premise is missing and turns surviving nodes into singletons", () => {
		const nodes = [{ id: "p1" }, { id: "c1" }];
		const chains = [{ id: "arg1", premises: ["p1", "p2"], conclusion: "c1" }];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "c1", premises: [], conclusion: "c1" },
			{ id: "p1", premises: [], conclusion: "p1" },
		]);
	});

	it("keeps a node off singletons if it is part of another surviving chain", () => {
		const nodes = [{ id: "p1" }, { id: "c1" }];
		const chains = [
			{ id: "arg_kept", premises: ["p1"], conclusion: "c1" },
			{ id: "arg_dropped", premises: ["p1", "p_missing"], conclusion: "c1" },
		];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "arg_kept", premises: ["p1"], conclusion: "c1" },
		]);
	});

	it("preserves distinct IDs for multiple independent chains supporting the same conclusion", () => {
		const nodes = [{ id: "p1" }, { id: "p2" }, { id: "c1" }];
		const chains = [
			{ id: "arg_second", premises: ["p2"], conclusion: "c1" },
			{ id: "arg_first", premises: ["p1"], conclusion: "c1" },
		];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "arg_first", premises: ["p1"], conclusion: "c1" },
			{ id: "arg_second", premises: ["p2"], conclusion: "c1" },
		]);
	});

	it("sorts chains by id and premises within each chain deterministically", () => {
		const nodes = [{ id: "z" }, { id: "b" }, { id: "a" }, { id: "c" }];
		const chains = [
			{ id: "chain_b", premises: ["z", "a"], conclusion: "b" },
		];
		const result = chainsForSelection(nodes, chains);
		assert.deepEqual(result, [
			{ id: "c", premises: [], conclusion: "c" },
			{ id: "chain_b", premises: ["a", "z"], conclusion: "b" },
		]);
	});
});

describe("formatChainLine", () => {
	it("formats a chain with premises joined by arrow using proposition names", () => {
		const chain = { premises: ["p2", "p1"], conclusion: "c1" };
		const props = {
			p1: { name: "First Premise" },
			p2: { name: "Second Premise" },
			c1: { name: "Final Conclusion" },
		};
		assert.equal(
			formatChainLine(chain, props),
			"First Premise, Second Premise → Final Conclusion",
		);
	});

	it("sorts premises by id before mapping to names", () => {
		const chain = { premises: ["b", "a"], conclusion: "c" };
		const props = {
			a: { name: "Alpha" },
			b: { name: "Beta" },
			c: { name: "Omega" },
		};
		assert.equal(formatChainLine(chain, props), "Alpha, Beta → Omega");
	});

	it("formats a singleton chain with the no premises marker", () => {
		const chain = { premises: [], conclusion: "solo" };
		const props = { solo: { name: "Independent Fact" } };
		assert.equal(formatChainLine(chain, props), "Independent Fact (no premises)");
	});

	it("falls back to the raw id when a proposition name is unknown", () => {
		const chain = { premises: ["p1", "missing_p"], conclusion: "missing_c" };
		const props = { p1: { name: "Known" } };
		assert.equal(formatChainLine(chain, props), "missing_p, Known → missing_c");
	});

	it("falls back to all raw ids when proposition map is empty", () => {
		const chain = { premises: ["p2", "p1"], conclusion: "c1" };
		assert.equal(formatChainLine(chain, {}), "p1, p2 → c1");
	});
});

describe("resolveTargetId", () => {
	const nodes = [
		{ id: "node_1", name: "First concept" },
		{ id: "node_2", name: "Second concept" },
		{ id: "node_dup1", name: "Ambiguous concept" },
		{ id: "node_dup2", name: "Ambiguous concept" },
	];

	it("resolves exact node id first", () => {
		assert.equal(resolveTargetId("node_1", nodes), "node_1");
		assert.equal(resolveTargetId("node_2", nodes), "node_2");
	});

	it("prefers an exact id over a node whose name equals that id", () => {
		const clashing = [
			{ id: "node_a", name: "node_b" },
			{ id: "node_b", name: "Other" },
		];
		assert.equal(resolveTargetId("node_b", clashing), "node_b");
	});

	it("resolves by case-insensitive name match", () => {
		assert.equal(resolveTargetId("first concept", nodes), "node_1");
		assert.equal(resolveTargetId("FIRST CONCEPT", nodes), "node_1");
		assert.equal(resolveTargetId("Second Concept", nodes), "node_2");
	});

	it("heals model value debris around targets and node names", () => {
		assert.equal(resolveTargetId(":node_1", nodes), "node_1");
		assert.equal(resolveTargetId('"node_1"', nodes), "node_1");
		assert.equal(resolveTargetId("`node_1`", nodes), "node_1");
		assert.equal(resolveTargetId('  : "First concept"  ', nodes), "node_1");
	});

	it("resolves ambiguous names to the first node in store order", () => {
		assert.equal(resolveTargetId("Ambiguous concept", nodes), "node_dup1");
	});

	it("returns null for empty target or unknown target", () => {
		assert.equal(resolveTargetId("", nodes), null);
		assert.equal(resolveTargetId("   ", nodes), null);
		assert.equal(resolveTargetId(":::\"\"", nodes), null);
		assert.equal(resolveTargetId("unknown concept", nodes), null);
	});
});

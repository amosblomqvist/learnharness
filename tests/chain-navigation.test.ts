import assert from "node:assert/strict";
import { it } from "node:test";
import { navigateChainRows, type ChainNavigationRow } from "../components/chain-navigation.ts";
const rows: ChainNavigationRow[] = [
	{ key: "folder", depth: 0, expanded: true }, { key: "nested", depth: 1, expanded: true },
	{ key: "book", depth: 2, expanded: true }, { key: "chain", depth: 3, expanded: true },
	{ key: "p1", depth: 4 }, { key: "p2", depth: 4 }, { key: "chain2", depth: 3, expanded: false },
	{ key: "book2", depth: 2, expanded: false }, { key: "rootBook", depth: 0, expanded: false },
];
it("empty and stale/initial focus safely begin at the first current top-level row", () => {
	assert.deepEqual(navigateChainRows([], null, "ArrowDown"), {});
	for (const active of [null, "deleted"]) assert.deepEqual(navigateChainRows(rows, active, "ArrowDown"), { key: "folder" });
});
it("Up/Down stay among siblings, skipping expanded descendants and never crossing a parent", () => {
	for (const [active, key, expected] of [
		["folder", "ArrowDown", "rootBook"], ["rootBook", "ArrowUp", "folder"],
		["book", "ArrowDown", "book2"], ["book2", "ArrowUp", "book"],
		["chain", "ArrowDown", "chain2"], ["chain2", "ArrowUp", "chain"],
		["p1", "ArrowDown", "p2"], ["p2", "ArrowUp", "p1"],
	]) assert.deepEqual(navigateChainRows(rows, active!, key!), { key: expected });
});
it("sibling boundaries stop rather than wrapping or exiting the layer", () => {
	for (const [active, key] of [["folder", "ArrowUp"], ["rootBook", "ArrowDown"], ["nested", "ArrowDown"], ["book", "ArrowUp"], ["book2", "ArrowDown"], ["p1", "ArrowUp"], ["p2", "ArrowDown"]]) {
		assert.deepEqual(navigateChainRows(rows, active!, key!), { key: active });
	}
});
it("Right enters the first child, expands collapsed rows, and does nothing to leaves", () => {
	assert.deepEqual(navigateChainRows(rows, "folder", "ArrowRight"), { key: "nested" });
	assert.deepEqual(navigateChainRows(rows, "chain", "ArrowRight"), { key: "p1" });
	assert.deepEqual(navigateChainRows(rows, "chain2", "ArrowRight"), { key: "chain2", toggle: "chain2", enter: true });
	assert.deepEqual(navigateChainRows(rows, "p1", "ArrowRight"), { key: "p1" });
});
it("Left returns to and collapses the parent; at the root it collapses the current row", () => {
	for (const [active, parent] of [["p2", "chain"], ["chain2", "book"], ["book2", "nested"], ["nested", "folder"], ["folder", "folder"]]) {
		assert.deepEqual(navigateChainRows(rows, active!, "ArrowLeft"), { key: parent, toggle: parent });
	}
	assert.deepEqual(navigateChainRows(rows, "rootBook", "ArrowLeft"), { key: "rootBook" });
});
it("navigation follows filtered/sorted visible rows instead of a separate source inventory", () => {
	const sorted = [rows[8]!, ...rows.slice(0, 8)];
	assert.deepEqual(navigateChainRows(sorted, "rootBook", "ArrowDown"), { key: "folder" });
	const filtered = rows.filter((r) => !["book2", "chain2", "p2"].includes(r.key));
	assert.deepEqual(navigateChainRows(filtered, "book", "ArrowDown"), { key: "book" });
	assert.deepEqual(navigateChainRows(filtered, "p1", "ArrowDown"), { key: "p1" });
});

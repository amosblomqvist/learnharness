/**
 * Plan ids are authoring data: a title like "func NewUser() *User" may
 * reasonably be keyed "constructor". dagre keys plain objects by node id
 * (order/sort-subgraph.js's `subgraphs` map among them), so an id naming an
 * Object.prototype member used to resolve to the prototype value instead of
 * the node. The layout then crashed assigning `order`, and "__proto__"
 * silently replaced the map's prototype instead of adding a node.
 * blockLayout must lay such ids out like any other.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { blockLayout, chartMeasure } from "../components/plan-layout.ts";

const RESERVED_IDS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

const NODES = RESERVED_IDS.map((id) => ({ id, title: `Step ${id}` }));
const EDGES = RESERVED_IDS.slice(0, -1).map((id, index) => ({ from: id, to: RESERVED_IDS[index + 1]! }));

test("plan node ids that collide with Object.prototype keys lay out", () => {
	const layout = blockLayout(NODES, EDGES, chartMeasure);

	for (const node of NODES) {
		const x = layout.x.get(node.id);
		const y = layout.y.get(node.id);
		assert.ok(Number.isFinite(x), `x for ${node.id}`);
		assert.ok(Number.isFinite(y), `y for ${node.id}`);
		assert.ok(layout.nodeW.get(node.id)! > 0, `width for ${node.id}`);
		assert.ok(layout.nodeH.get(node.id)! > 0, `height for ${node.id}`);
	}

	for (const edge of EDGES) {
		const points = layout.edgePts.get(`${edge.from}->${edge.to}`);
		assert.ok(points && points.length >= 2, `route for ${edge.from}->${edge.to}`);
	}

	assert.ok(layout.width > 0);
	assert.ok(layout.height > 0);
});

test("ordinary ids keep their geometry", () => {
	const nodes = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
	const layout = blockLayout(nodes, [{ from: "a", to: "b" }], chartMeasure);
	assert.ok(layout.y.get("b")! > layout.y.get("a")!);
});

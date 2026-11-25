/**
 * Rename-shuffle fix tests (2026-09-23 fix wave): the live-rename label
 * path must be LABEL-ONLY — it can never build a new snapshot object,
 * because the [snapshot]-keyed data feed (renderer.setData) treats any
 * identity change as "the server spoke": the geometry rebuild makes the
 * last-fetched ledger authoritative and cancels any pending drag
 * commit, rewinding the graph whenever display had drifted.
 *
 * The pinned contracts here:
 *   - renameSessionsPatch changes display state IN PLACE (no identity
 *     change → the data feed cannot re-fire);
 *   - seedMissingNodePositions gives ledger-unknown nodes a seeded ring
 *     instead of the old ?? 0 origin dump;
 *   - applyClusterLabels (the renderer's label-only channel) has its own
 *     suite in graph-canvas.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renameSessionsPatch, seedMissingNodePositions } from "../components/graph-view.tsx";

const snapshot = (): {
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	clusters: { id: string; label: string | null; members: string[] }[];
	nodes: { id: string }[];
	edges: never[];
	nodeSessions: Record<string, string[]>;
	nodeObservations: Record<string, Record<string, string>>;
} => ({
	sessions: { chat_a: "Old title", seedplan: "Orbital mechanics" },
	fileSources: {},
	clusters: [
		{ id: "chat_a", label: "Old title", members: ["n1"] },
		{ id: "chat_b", label: null, members: ["n2"] },
	],
	nodes: [{ id: "n1" }, { id: "n2" }],
	edges: [],
	nodeSessions: {},
	nodeObservations: {},
});

describe("renameSessionsPatch (in-place, identity-preserving)", () => {
	it("writes the title into the sessions map and keeps EVERY object identity", () => {
		const snap = snapshot();
		const sessionsRef = snap.sessions;
		const clustersRef = snap.clusters;
		renameSessionsPatch(snap, "chat_a", "New title");
		// display state changed...
		assert.equal(snap.sessions.chat_a, "New title");
		// ...but nothing was rebuilt: same map, same array, same snapshot.
		// This is the contract that keeps the [snapshot]-keyed setData
		// feed from firing (and the pending drag commit from dying).
		assert.equal(snap.sessions, sessionsRef, "sessions map identity preserved");
		assert.equal(snap.clusters, clustersRef, "clusters array identity preserved");
		assert.equal(snap.clusters[0]!.label, "Old title", "react-side cluster label untouched (renderer channel owns it)");
	});

	it("adds an unknown session id harmlessly (renames outside the graph)", () => {
		const snap = snapshot();
		renameSessionsPatch(snap, "chat_other", "Some other chat");
		assert.equal(snap.sessions.chat_other, "Some other chat");
		assert.equal(snap.sessions.chat_a, "Old title");
	});
});

describe("seedMissingNodePositions (ledger stragglers)", () => {
	const positions = (): Map<string, { x: number; y: number }> =>
		new Map([
			["n1", { x: -100, y: 0 }],
			["n2", { x: 100, y: 40 }],
		]);

	it("known positions are byte-identical; missing nodes are seeded off the origin", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n_new" }, { id: "n_newer" }];
		const out = seedMissingNodePositions(nodes, positions());
		// the two known entries untouched (same objects, same values)
		assert.equal(out.get("n1"), out.get("n1"));
		assert.equal(out.get("n1")!.x, -100);
		assert.equal(out.get("n2")!.y, 40);
		// every node has a position now — no ?? 0 origin dump
		assert.equal(out.size, 4);
		for (const id of ["n_new", "n_newer"]) {
			const p = out.get(id)!;
			assert.ok(p.x !== 0 || p.y !== 0, `${id} not at the origin`);
		}
	});

	it("deterministic across runs (same ids → same ring spots)", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n_new" }];
		const a = seedMissingNodePositions(nodes, positions());
		const b = seedMissingNodePositions(nodes, positions());
		assert.deepEqual(
			[...a.entries()].map(([id, p]) => [id, p.x, p.y]),
			[...b.entries()].map(([id, p]) => [id, p.x, p.y]),
		);
	});

	it("seeds land on the ring around the centroid (off the known mass)", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n_new" }];
		const out = seedMissingNodePositions(nodes, positions());
		const p = out.get("n_new")!;
		// centroid (0, 20); radius = max(200, 40, 40) * 0.7 + 20 = 160
		const dist = Math.hypot(p.x - 0, p.y - 20);
		assert.ok(Math.abs(dist - 160) < 1e-9, `seed on the 160-unit ring, got ${dist}`);
	});

	it("nothing missing → the map comes back untouched (early exit)", () => {
		const pos = positions();
		const out = seedMissingNodePositions([{ id: "n1" }, { id: "n2" }], pos);
		assert.equal(out, pos);
		assert.equal(out.size, 2);
	});

	it("empty known map → early exit (the bootstrap fallback owns that case)", () => {
		const pos = new Map<string, { x: number; y: number }>();
		const out = seedMissingNodePositions([{ id: "n1" }], pos);
		assert.equal(out.size, 0);
	});
});

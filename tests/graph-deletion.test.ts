import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint } from "../src/core/contracts.ts";
import { deleteChatTraces, deleteNodeTraces, deleteSourcesTraces } from "../src/core/graph-deletion.ts";
import type { GraphStore } from "../src/core/ports.ts";

interface MemoryGraphState {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
	positions: Record<string, Position>;
	positionWrites: number;
	ledgerRewrites: number;
}

function createMemoryGraphStore(initial: Partial<MemoryGraphState> = {}): { store: GraphStore; state: MemoryGraphState } {
	const state: MemoryGraphState = {
		nodes: [...(initial.nodes ?? [])],
		chains: [...(initial.chains ?? [])],
		coverage: [...(initial.coverage ?? [])],
		checkpoints: [...(initial.checkpoints ?? [])],
		positions: { ...(initial.positions ?? {}) },
		positionWrites: 0,
		ledgerRewrites: 0,
	};
	const store: GraphStore = {
		appendNode: (node) => { state.nodes.push(node); },
		readNodes: () => state.nodes,
		appendChain: (chain) => { state.chains.push(chain); },
		readChains: () => state.chains,
		appendCheckpoint: (checkpoint) => { state.checkpoints.push(checkpoint); },
		readCheckpoints: () => state.checkpoints,
		appendCoverage: (entry) => { state.coverage.push(entry); },
		readCoverage: () => state.coverage,
		upsertSource: () => {},
		readSources: () => [],
		deleteSources: () => 0,
		appendSourceUsage: () => {},
		readPositions: () => state.positions,
		writePositions: (positions) => {
			state.positionWrites++;
			state.positions = { ...positions };
		},
		rewriteLedgers: (next) => {
			state.ledgerRewrites++;
			if (next.nodes !== undefined) state.nodes = [...next.nodes];
			if (next.chains !== undefined) state.chains = [...next.chains];
			if (next.coverage !== undefined) state.coverage = [...next.coverage];
			if (next.checkpoints !== undefined) state.checkpoints = [...next.checkpoints];
		},
	};
	return { store, state };
}

function makeNode(id: string, chatIds: string[], aliases: string[] = []): GraphNode {
	return {
		id,
		name: id,
		statement: `${id} statement`,
		aliases,
		createdAt: "2026-10-01T00:00:00.000Z",
		provenance: chatIds.map((chatId) => ({ chatId, messageId: "" })),
	};
}

function makeChain(id: string, premises: string[], conclusion: string, chatIds: string[]): GraphChain {
	return {
		id,
		premises,
		conclusion,
		createdAt: "2026-10-01T00:00:00.000Z",
		provenance: chatIds.map((chatId) => ({ chatId, messageId: "" })),
	};
}

describe("graph-deletion chain position pruning", () => {
	it("preserves resting positions of shared chains when another session's assertion line survives", () => {
		const { store, state } = createMemoryGraphStore({
			nodes: [
				makeNode("n_p1", ["chat_a"]),
				makeNode("n_p1", ["chat_b"]),
				makeNode("n_p2", ["chat_a"]),
				makeNode("n_p2", ["chat_b"]),
				makeNode("n_c", ["chat_a"]),
				makeNode("n_c", ["chat_b"]),
				makeNode("n_only_a", ["chat_a"]),
			],
			chains: [
				// Two separate assertion lines sharing one arg_ id (normal mergeFindings link-append format).
				makeChain("arg_shared", ["n_p1", "n_p2"], "n_c", ["chat_a"]),
				makeChain("arg_shared", ["n_p1", "n_p2"], "n_c", ["chat_b"]),
				makeChain("arg_solo", ["n_p1", "n_p2"], "n_only_a", ["chat_a"]),
			],
			positions: {
				n_p1: { x: 1, y: 1 },
				n_p2: { x: 2, y: 2 },
				n_c: { x: 3, y: 3 },
				n_only_a: { x: 4, y: 4 },
				arg_shared: { x: 10, y: 20 },
				arg_solo: { x: 30, y: 40 },
			},
		});

		const stats = deleteChatTraces(store, "chat_a", "delete-nodes");
		assert.equal(stats.nodesRemoved, 1);
		assert.equal(stats.chainsRemoved, 2);

		assert.deepEqual(state.chains.map((c) => c.id), ["arg_shared"]);
		assert.deepEqual(state.chains[0]?.provenance, [{ chatId: "chat_b", messageId: "" }]);
		assert.deepEqual(state.positions.arg_shared, { x: 10, y: 20 });
		assert.equal(state.positions.arg_solo, undefined);
		assert.equal(state.positions.n_only_a, undefined);
	});

	it("preserves resting positions of mixed-provenance chain lines that survive source deletion", () => {
		const { store, state } = createMemoryGraphStore({
			nodes: [
				makeNode("n_p1", ["chat_a", "chat_b"]),
				makeNode("n_p2", ["chat_a", "chat_b"]),
				makeNode("n_c", ["chat_a", "chat_b"]),
			],
			chains: [
				makeChain("arg_mixed", ["n_p1", "n_p2"], "n_c", ["chat_a", "chat_b"]),
			],
			positions: {
				n_p1: { x: 1, y: 1 },
				n_p2: { x: 2, y: 2 },
				n_c: { x: 3, y: 3 },
				arg_mixed: { x: 15, y: 25 },
			},
		});

		const stats = deleteChatTraces(store, "chat_a", "delete-nodes");
		assert.equal(stats.nodesRemoved, 0);
		assert.equal(stats.chainsRemoved, 0);

		assert.equal(state.chains.length, 1);
		assert.deepEqual(state.chains[0]?.provenance, [{ chatId: "chat_b", messageId: "" }]);
		assert.deepEqual(state.positions.arg_mixed, { x: 15, y: 25 });
		assert.equal(state.positionWrites, 0, "no position write is needed when every tracked id survives");
	});

	it("prunes a shared chain's resting position when every asserting source is deleted in one batch", () => {
		const { store, state } = createMemoryGraphStore({
			nodes: [
				makeNode("n_p1", ["chat_a"]),
				makeNode("n_p1", ["chat_b"]),
				makeNode("n_p2", ["chat_a"]),
				makeNode("n_p2", ["chat_b"]),
				makeNode("n_c", ["chat_a"]),
				makeNode("n_c", ["chat_b"]),
				makeNode("n_other", ["chat_c"]),
			],
			chains: [
				makeChain("arg_shared", ["n_p1", "n_p2"], "n_c", ["chat_a"]),
				makeChain("arg_shared", ["n_p1", "n_p2"], "n_c", ["chat_b"]),
			],
			positions: {
				n_p1: { x: 1, y: 1 },
				n_p2: { x: 2, y: 2 },
				n_c: { x: 3, y: 3 },
				n_other: { x: 9, y: 9 },
				arg_shared: { x: 10, y: 20 },
				arg_untracked: { x: 50, y: 60 },
			},
		});

		const stats = deleteSourcesTraces(store, new Set(["chat_a", "chat_b"]), "delete-nodes");
		assert.equal(stats.nodesRemoved, 3);
		assert.equal(stats.chainsRemoved, 2);
		assert.deepEqual(state.chains, []);
		assert.equal(state.positions.arg_shared, undefined);
		assert.deepEqual(state.positions.n_other, { x: 9, y: 9 });
		assert.deepEqual(state.positions.arg_untracked, { x: 50, y: 60 });
	});

	it("keeps empty-provenance legacy chains and their resting positions untouched", () => {
		const { store, state } = createMemoryGraphStore({
			nodes: [
				makeNode("n_legacy_a", []),
				makeNode("n_legacy_b", []),
				makeNode("n_dead", ["chat_a"]),
			],
			chains: [
				makeChain("arg_legacy", ["n_legacy_a"], "n_legacy_b", []),
				makeChain("arg_dead", ["n_legacy_a"], "n_dead", ["chat_a"]),
			],
			positions: {
				n_legacy_a: { x: 1, y: 1 },
				n_legacy_b: { x: 2, y: 2 },
				n_dead: { x: 3, y: 3 },
				arg_legacy: { x: 11, y: 12 },
				arg_dead: { x: 13, y: 14 },
			},
		});

		const stats = deleteChatTraces(store, "chat_a", "delete-nodes");
		assert.equal(stats.nodesRemoved, 1);
		assert.equal(stats.chainsRemoved, 1);
		assert.deepEqual(state.chains.map((c) => c.id), ["arg_legacy"]);
		assert.deepEqual(state.positions.arg_legacy, { x: 11, y: 12 });
		assert.equal(state.positions.arg_dead, undefined);
	});
});

describe("deleteSourcesTraces guards and deleteNodeTraces argument deletion", () => {
	it("rejects unknown deletion modes and short-circuits empty source sets", () => {
		const { store, state } = createMemoryGraphStore({
			nodes: [makeNode("n_1", ["chat_a"])],
		});
		assert.throws(
			() => deleteSourcesTraces(store, new Set(["chat_a"]), "invalid" as never),
			/Unknown deletion mode/,
		);
		assert.deepEqual(deleteSourcesTraces(store, new Set(), "delete-nodes"), {
			nodesRemoved: 0,
			chainsRemoved: 0,
			coverageRemoved: 0,
			checkpointsRemoved: 0,
		});
		assert.equal(state.ledgerRewrites, 0);
	});

	it("deleteNodeTraces removes an argument by arg_ id and its position without deleting member propositions", () => {
		const { store, state } = createMemoryGraphStore({
			nodes: [
				makeNode("n_p1", ["chat_a"]),
				makeNode("n_p2", ["chat_a"]),
				makeNode("n_c", ["chat_a"]),
			],
			chains: [
				makeChain("arg_target", ["n_p1", "n_p2"], "n_c", ["chat_a"]),
				makeChain("arg_target", ["n_p1", "n_p2"], "n_c", ["chat_b"]),
				makeChain("arg_keep", ["n_p1"], "n_c", ["chat_a"]),
			],
			positions: {
				n_p1: { x: 1, y: 1 },
				n_p2: { x: 2, y: 2 },
				n_c: { x: 3, y: 3 },
				arg_target: { x: 10, y: 20 },
				arg_keep: { x: 30, y: 40 },
			},
		});

		const stats = deleteNodeTraces(store, "arg_target");
		assert.deepEqual(stats, { chainsRemoved: 2 });
		assert.deepEqual(state.nodes.map((n) => n.id), ["n_p1", "n_p2", "n_c"]);
		assert.deepEqual(state.chains.map((c) => c.id), ["arg_keep"]);
		assert.equal(state.positions.arg_target, undefined);
		assert.deepEqual(state.positions.arg_keep, { x: 30, y: 40 });
		assert.equal(deleteNodeTraces(store, "arg_target"), null);
	});
});

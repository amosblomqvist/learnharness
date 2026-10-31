/**
 * BIRTH-SESSION CLUSTERING + THE PROBER GRAPH-TOOLS DATA SEAM (wave 7,
 * owner-locked 2026-09-23): embeddings are dead — a proposition's cluster
 * is the session that created it, derived on read from provenance
 * (session-clusters.ts); labels are session names; the prober tools read a
 * session list + per-session propositions with the extractor's latest
 * understanding level and its own timestamp. All in-memory fakes — the
 * fs-backed snapshot join (with the real store adapters) lives in
 * graph.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, NotesSource, ChatSummary } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import {
	graphSessionIndex,
	graphSessionPropositions,
	graphSnapshot,
	type GraphDeps,
} from "../src/core/graph.ts";
import {
	attachImpToCommunities,
	birthSessionOf,
	birthSessionPartition,
	impClusterKey,
} from "../src/core/session-clusters.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
/** attachImpToCommunities takes a structural Pick; full chains are
 *  assignable but literals need the widening. */
const attachable = (c: GraphChain): Pick<GraphChain, "id" | "premises" | "conclusion" | "provenance"> => c;
const node = (id: string, name: string, provenance: Array<{ chatId: string; messageId: string }>): GraphNode => ({
	id,
	name,
	statement: `${name} statement`,
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
		sources?: Array<Pick<NotesSource, "id" | "filePath" | "importedAt">>;
		chains?: GraphChain[];
	} = {},
): GraphDeps {
	const chains: GraphChain[] = over.chains ?? [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () =>
			(over.sources ?? []).map((s) => ({ ...s, extractions: [] }) as unknown as NotesSource),
		readPositions: () => ({}),
		writePositions: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

// ─── the partition ──────────────────────────────────────────────────────────

describe("birthSessionPartition", () => {
	it("groups by the first provenance point, dedupes repeated lines, sorts deterministically", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat2")]),
			node("a", "A-linked", [pt("chat2")]), // link-append line for "a": ignored (first defines)
			node("d", "D", [pt("chat1")]),
		];
		assert.deepEqual(birthSessionPartition(nodes), [
			{ id: "chat1", members: ["a", "b", "d"] },
			{ id: "chat2", members: ["c"] },
		]);
	});

	it("a SHARED node belongs to its birth session only — later contributors never claim it", () => {
		const nodes = [
			node("born-1", "X", [pt("chat1")]),
			node("born-1", "X-linked", [pt("chat2")]), // chat2 re-encountered it
			node("born-2", "Y", [pt("chat2")]),
		];
		assert.deepEqual(birthSessionPartition(nodes), [
			{ id: "chat1", members: ["born-1"] },
			{ id: "chat2", members: ["born-2"] },
		], "chat2 holds only what it BIRTHED — sizes tie (1/1), id order breaks it");
	});

	it("deletion re-attribution: a stripped birth falls to the earliest remaining contributor; no provenance = unclustered", () => {
		// What delete-nodes leaves behind: the birth session's points are
		// stripped from surviving lines — the merged provenance walks forward.
		const reattributed = node("survivor", "S", [pt("chat2"), pt("chat3")]);
		assert.equal(birthSessionOf(reattributed), "chat2");
		const naked = node("naked", "N", []);
		assert.equal(birthSessionOf(naked), null);
		const partition = birthSessionPartition([reattributed, naked]);
		assert.deepEqual(partition, [{ id: "chat2", members: ["survivor"] }], "the naked node joins nothing");
	});
});

// ─── notes files as birth sessions (production shape) ────────────────────────

describe("notes files as birth sessions", () => {
	// The mapping-line fallback is GONE (owner, 2026-09-29): the mappings
	// ledger itself died with per-job in-memory resolution, and every merge
	// writes provenance points — the src id IS the birth session.
	it("graphSessionIndex lists imported files as kind:file with birth counts (production shape)", () => {
		const nodes = [node("a", "Alpha", [pt("src_abc")]), node("b", "Beta", [pt("src_abc")]), node("c", "Gamma", [pt("src_abc")])];
		const deps = fakeStores(nodes, {
			sources: [{ id: "src_abc", filePath: "/vault/learn vim.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const index = graphSessionIndex(deps);
		assert.deepEqual(index, [
			{
				id: "src_abc",
				name: "/vault/learn vim.md",
				kind: "file",
				createdAt: "2026-09-22T00:00:00.000Z",
				updatedAt: "2026-09-22T00:00:00.000Z",
				propositions: 3,
			},
		], "the file births under its src id; the childless chat has no entry (birth sessions only)");
	});

	it("graphSessionPropositions lists the file's births under the src id (a pure birth list, 2026-09-27)", () => {
		const deps = fakeStores([node("a", "Alpha", [pt("src_abc")]), node("b", "Beta", [pt("src_abc")])], {
			sources: [{ id: "src_abc", filePath: "/vault/learn vim.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		assert.deepEqual(graphSessionPropositions(deps, "src_abc"), [
			{ nodeId: "a", name: "Alpha" },
			{ nodeId: "b", name: "Beta" },
		]);
	});
});

// ─── the snapshot join ──────────────────────────────────────────────────────

describe("graphSnapshot birth-session clusters", () => {
	it("labels clusters with session names (chat title / file path), keeps the ≥3 hull rule", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat1")]),
			node("d", "D", [pt("src_notes")]),
			node("e", "E", [pt("src_notes")]),
			node("f", "F", [pt("src_notes")]),
		];
		const deps = fakeStores(nodes, {
			chats: [{ id: "chat1", title: "Learning session", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" }],
			sources: [{ id: "src_notes", filePath: "/vault/notes.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const snap = graphSnapshot(deps);
		assert.equal(snap.clusters.length, 2);
		const byLabel = new Map(snap.clusters.map((c) => [c.label, c]));
		assert.deepEqual(byLabel.get("Learning session"), {
			id: "chat1",
			label: "Learning session",
			members: ["a", "b", "c"],
		});
		assert.deepEqual(byLabel.get("notes"), {
			id: "src_notes",
			label: "notes",
			members: ["d", "e", "f"],
		}, "a notes file is a birth-session too (owner ruling)");
		// A 2-proposition session renders no hull (the presentation rule).
		const two = fakeStores([node("x", "X", [pt("chat1")]), node("y", "Y", [pt("chat1")])], {
			chats: [{ id: "chat1", title: "tiny", createdAt: "", updatedAt: "" }],
		});
		assert.equal(graphSnapshot(two).clusters.length, 0);
	});

	it("a birth session whose record is gone keeps its members but renders unlabeled", () => {
		const nodes = [node("a", "A", [pt("gone")]), node("b", "B", [pt("gone")]), node("c", "C", [pt("gone")])];
		const snap = graphSnapshot(fakeStores(nodes));
		assert.equal(snap.clusters.length, 1);
		assert.equal(snap.clusters[0]!.label, null);
		assert.equal(snap.clusters[0]!.id, "gone");
	});
});

// ─── the prober data seam ───────────────────────────────────────────────────

describe("graphSessionIndex (the prober's session list)", () => {
	it("birth counts, chat/file kinds, recency order, deleted records fall back honestly", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat1")]),
			node("d", "D", [pt("src_notes")]),
			node("e", "E", [pt("gone")]), // its chat record no longer exists
		];
		const deps = fakeStores(nodes, {
			chats: [
				{ id: "chat1", title: "Older session", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" },
			],
			sources: [{ id: "src_notes", filePath: "/vault/notes.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const index = graphSessionIndex(deps);
		assert.deepEqual(index, [
			{
				id: "src_notes",
				name: "/vault/notes.md",
				kind: "file",
				createdAt: "2026-09-22T00:00:00.000Z",
				updatedAt: "2026-09-22T00:00:00.000Z",
				propositions: 1,
			},
			{
				id: "chat1",
				name: "Older session",
				kind: "chat",
				createdAt: "2026-09-20T00:00:00.000Z",
				updatedAt: "2026-09-21T00:00:00.000Z",
				propositions: 3,
			},
			{
				id: "gone",
				name: "gone",
				kind: "file",
				createdAt: null,
				updatedAt: null,
				propositions: 1,
			},
		], "most recent first; the undatable record sinks and names itself by id");
	});
});

describe("graphSessionPropositions (the per-session view)", () => {
	it("birth propositions — a pure list, no evaluations (2026-09-27 cleanup)", () => {
		const nodes = [
			node("a", "Alpha", [pt("chat1")]),
			node("b", "Beta", [pt("chat1")]),
			node("c", "Gamma", [pt("chat2")]), // born elsewhere — never listed under chat1
		];
		const deps = fakeStores(nodes);
		assert.deepEqual(graphSessionPropositions(deps, "chat1"), [
			{ nodeId: "a", name: "Alpha" },
			{ nodeId: "b", name: "Beta" },
		]);
	});
});

// ─── imp-node cluster assignment (physics arc, owner 2026-09-30) ─────────────

describe("impClusterKey (majority among PREMISES' births)", () => {
	const chainOf = (premises: string[], provenance: Array<{ chatId: string; messageId: string }> = []) =>
		({ id: "arg_t", premises, conclusion: "c", provenance, createdAt: "2026-09-30T00:00:00.000Z" }) as GraphChain;

	it("unanimous premises → that session", () => {
		const key = impClusterKey(chainOf(["p1", "p2", "p3"]), () => "chatA");
		assert.equal(key, "chatA");
	});

	it("cross-session majority wins (2 of 3 premises born in chatA)", () => {
		const births: Record<string, string | null> = { p1: "chatA", p2: "chatA", p3: "chatB" };
		const key = impClusterKey(chainOf(["p1", "p2", "p3"]), (id) => births[id] ?? null);
		assert.equal(key, "chatA");
	});

	it("tie → the chain's OWN birth (the asserting session), not the conclusion's", () => {
		const births: Record<string, string | null> = { p1: "chatA", p2: "chatB", c: "chatC" };
		const key = impClusterKey(chainOf(["p1", "p2"], [pt("chatT")]), (id) => births[id] ?? null);
		assert.equal(key, "chatT", "the chain's first provenance point breaks the tie");
	});

	it("no birth info at all → null is honest", () => {
		assert.equal(impClusterKey(chainOf(["p1", "p2"]), () => null), null);
	});
});

describe("attachImpToCommunities (the shared seam for pull + hulls)", () => {
	it("a multi-premise live chain's imp id joins its home community, members stay sorted", () => {
		const props = [node("p1", "P1", [pt("chatA")]), node("p2", "P2", [pt("chatA")]), node("p3", "P3", [pt("chatA")])];
		const communities = birthSessionPartition(props);
		attachImpToCommunities(communities, props, [
			attachable({ id: "arg_t", premises: ["p1", "p2"], conclusion: "p3", provenance: [pt("chatA")], createdAt: "2026-09-30T00:00:00.000Z" }),
		]);
		assert.deepEqual(communities[0]!.members, ["arg_t", "p1", "p2", "p3"]);
	});

	it("single-premise chains attach NOTHING (no imp node exists — the collapse)", () => {
		const props = [node("p1", "P1", [pt("chatA")]), node("p2", "P2", [pt("chatA")])];
		const communities = birthSessionPartition(props);
		attachImpToCommunities(communities, props, [
			attachable({ id: "arg_t", premises: ["p1"], conclusion: "p2", provenance: [pt("chatA")], createdAt: "2026-09-30T00:00:00.000Z" }),
		]);
		assert.deepEqual(communities[0]!.members, ["p1", "p2"]);
	});

	it("dangling chains mint nothing; a home community ABSENT from the list stays unattached", () => {
		const props = [
			node("p1", "P1", [pt("chatA")]),
			node("p1b", "P1b", [pt("chatA")]),
			node("p1c", "P1c", [pt("chatA")]),
		];
		const elsewhere = [{ id: "chatB", members: ["q1"] }];
		attachImpToCommunities(
			elsewhere,
			props,
			[
				// dangling conclusion — no imp node is minted, nothing to attach
				attachable({ id: "arg_gone", premises: ["p1", "p1b"], conclusion: "ghost", provenance: [pt("chatA")], createdAt: "2026-09-30T00:00:00.000Z" }),
				// fully live, but its home community (chatA) is not in the
				// list — the post-hull-filter case: stays unclustered
				attachable({ id: "arg_home", premises: ["p1", "p1b"], conclusion: "p1c", provenance: [pt("chatA")], createdAt: "2026-09-30T00:00:00.000Z" }),
			],
		);
		assert.deepEqual(elsewhere[0]!.members, ["q1"]);
	});
});

// ─── the snapshot seam: imp ids ride cluster members to BOTH consumers ──────

describe("graphSnapshot imp-node cluster assignment (physics arc, 2026-09-30)", () => {
	const chats = [{ id: "chatA", title: "Session A", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }];
	const multi = (id: string, premises: string[], conclusion: string, chatId = "chatA"): GraphChain => ({
		id, premises, conclusion, provenance: [pt(chatId)], createdAt: "2026-09-30T00:00:00.000Z",
	});

	it("a live multi-premise chain's imp id JOINS the cluster's members (pull + hull read this list)", () => {
		const snap = graphSnapshot(
			fakeStores(
				[node("p1", "P1", [pt("chatA")]), node("p2", "P2", [pt("chatA")]), node("p3", "P3", [pt("chatA")])],
				{ chats, chains: [multi("arg_t", ["p1", "p2"], "p3")] },
			),
		);
		assert.equal(snap.clusters.length, 1);
		assert.ok(snap.clusters[0]!.members.includes("arg_t"), "the imp node is a member — centroid pull AND hull rasterization consume members");
	});

	it("the hull filter counts PROPOSITIONS — attaching an imp never resurrects a 2-member hull", () => {
		// p1,p2 born chatA; the conclusion born chatB. The chain is fully
		// live, its premises-majority home is chatA — a 2-proposition
		// community the hull filter drops; the imp id must NOT tip it to 3.
		const snap = graphSnapshot(
			fakeStores(
				[node("p1", "P1", [pt("chatA")]), node("p2", "P2", [pt("chatA")]), node("p3b", "P3b", [pt("chatB")])],
				{ chats, chains: [multi("arg_t", ["p1", "p2"], "p3b")] },
			),
		);
		assert.equal(snap.clusters.length, 0, "two propositions + a bundle is still not a hull");
	});
});

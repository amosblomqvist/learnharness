// THE PROBER'S GRAPH TOOLS (wave 7; understanding levels removed
// 2026-09-27) — pinned behaviors:
// 1. REGISTRATION: the factory registers list_sessions/list_propositions
//    on the prober ONLY when the composition root passes a graphStore
//    (the graphToolsEnabled gate lives server-side; absent store = closed
//    gate — the factory must not reach for settings itself).
// 2. OUTPUT: names only — the owner ruling bars statement text and session
//    contents from the prober's view of the map.
// 3. HONESTY: empty graph, unknown session id — the tools answer in
//    their own voice, never throw, never guess.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import { auditorGraphTools } from "../src/agent/tools/graph.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must NEVER leak into tool output
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const chains: GraphChain[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
		writePositions: () => {},
		readClusterLabels: () => [],
		appendClusterLabel: () => {},
		appendNamingRun: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
};

// ─── registration (the factory gate) ────────────────────────────────────────

describe("prober graph tools — registration", () => {
	it("no graphStore in the context → the tools are absent (gate decided server-side)", () => {
		const { chatStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore });
		assert.equal("list_sessions" in tools, false);
		assert.equal("list_propositions" in tools, false);
	});

	it("graphStore present → list_sessions + list_propositions join the registry beside the usual set", () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		// The standing set (fix wave 2026-09-20: research + pdf are
		// phase-omnipresent) plus the two graph-map readers.
		assert.deepEqual(Object.keys(tools).sort(), [
			"ask_user_question",
			"find",
			"grep",
			"list_propositions",
			"list_sessions",
			"ls",
			"pdf",
			"probe",
			"probe_done",
			"read",
			"research",
			"send_to_user",
		]);
	});
});

// ─── output shape + the no-prose rule ──────────────────────────────────────

describe("list_sessions", () => {
	it("names, kinds, counts, dates, ids — in the prober's voice, no statements", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n1", "Water cycle", [pt("c1")]),
				node("n2", "Evaporation", [pt("c1")]),
				node("n3", "Nietzsche", [pt("c-file")]),
			],
			{
				chats: [
					{
						id: "c1",
						title: "First lesson",
						createdAt: "2026-09-20T10:00:00.000Z",
						updatedAt: "2026-09-21T10:00:00.000Z",
					},
				],
			},
		);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /2 session\(s\) in the knowledge graph, most recent first:/);
		// The chat: name, kind, born count, dates, id — the full resume.
		assert.match(out, /First lesson \(chat, 2 propositions, born 2026-09-20T10:00:00.000Z, last active 2026-09-21T10:00:00.000Z\) — id: c1/);
		// The unrecorded birth session falls back honestly: the id, no fake date.
		assert.match(out, /c-file \(file, 1 proposition, born unknown date\) — id: c-file/);
		// The owner ruling: the map's prose never reaches the prober.
		assert.ok(!out.includes("statement of"));
	});

	it("an empty graph gets an honest answer, not an empty string or a throw", async () => {
		const { chatStore, graphStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.equal(out, "The knowledge graph is empty — no session has contributed propositions yet.");
	});
});

describe("list_propositions", () => {
	it("names only — what the session covered (2026-09-27: no levels, no dating)", async () => {
		const { chatStore, graphStore } = fakeStores([
			node("n1", "Water cycle", [pt("c1")]),
			node("n2", "Evaporation", [pt("c1")]),
		]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) covered in this session:/);
		assert.match(out, /- Water cycle/);
		assert.match(out, /- Evaporation/);
		// The owner ruling: no levels, no dating, never the statement text.
		assert.ok(!out.includes("as of"));
		assert.ok(!out.includes("solid"));
		assert.ok(!out.includes("statement of"));
	});

	it("no evaluation machinery at all — the covered list is the whole output", async () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /- Water cycle/);
		assert.ok(!out.includes("never evaluated"));
	});

	it("an unknown session id — honest redirect, not a throw", async () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(out, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});

// ─── the auditor's toolset (2026-09-27 relink) ───────────────────────────────

describe("auditor graph tools", () => {
	const nodes = [
		{ ...node("n1", "Will to power", [pt("c1")]), statement: "The will to power is Nietzsche's central drive.", aliases: ["power drive"] },
		{ ...node("n2", "Eternal recurrence", [pt("c1")]), statement: "Eternal recurrence is the thought experiment of living again.", aliases: [] },
	];
	const { chatStore, graphStore } = fakeStores(nodes);

	it("find: glob over names + statements + aliases, returning id + name + statement + BIRTH SESSION (owner, 2026-09-29)", async () => {
		const tools = auditorGraphTools({ chatStore, graphStore });
		const out = (await tools.find!.execute!("tc", { query: "*will to power*" })).details as string;
		assert.match(out, /1 match\(es\):/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		// The born-in pointer: hits compose with list_propositions.
		assert.match(out, /born in: c1/);
		// Statements and aliases hit too — and a bare term gets implicit stars.
		const byStatement = (await tools.find!.execute!("tc", { query: "living again" })).details as string;
		assert.match(byStatement, /n2 :: Eternal recurrence/);
		const byAlias = (await tools.find!.execute!("tc", { query: "power drive" })).details as string;
		assert.match(byAlias, /n1/);
		const miss = (await tools.find!.execute!("tc", { query: "*nothing matches this*" })).details as string;
		assert.equal(miss, 'No existing proposition matches "*nothing matches this*".');
	});

	it("list_sessions: names, kinds, counts, ids — NO timestamps (identity work needs content, not chronology)", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes, {
			chats: [{ id: "c1", title: "Nietzsche seminar", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z" }],
		});
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /1 session\(s\):/);
		assert.match(out, /Nietzsche seminar \(chat, 2 propositions\) — id: c1/);
		assert.ok(!out.includes("2026-09-20"), "no dates in the auditor's view");
	});

	it("list_propositions: FULL statement text (identity work), no dates", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes);
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) born in this session:/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		assert.ok(!out.includes("2026-09"), "no dates in the auditor's view");
		const miss = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(miss, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});

/**
 * Plan-tree tests (W1) — two layers:
 *
 *  1. Pure ops (src/core/plan-tree.ts): every validation error path and
 *     version semantics (structure only — progress derives from the
 *     transcript, docs/probe-teach-split.md §3).
 *  2. Tool execute (src/agent/tools/plan.ts): against the REAL chat store —
 *     plan_init happy path, the re-callable rewrite, error results.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { derivePlanStatuses, derivedNodeStatus, type PlanTree, type PlanToolResult } from "../src/core/contracts.ts";
import { createTree, emptyTree, PlanTreeError } from "../src/core/plan-tree.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { parseMermaidPlan } from "../src/agent/tools/mermaid-plan.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";
import { subscribe } from "../src/core/events.ts";

const N = (id: string, title = id, summary?: string) => ({ id, title, ...(summary ? { summary } : {}) });
const E = (from: string, to: string) => ({ from, to });

function tree(ids: string[], edges: Array<[string, string]> = []): PlanTree {
	return createTree(
		ids.map((id) => N(id)),
		edges.map(([from, to]) => E(from, to)),
	);
}

/** Assert the op throws a PlanTreeError matching the given regex. */
function assertReject(fn: () => unknown, needle: RegExp): void {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof PlanTreeError, `expected PlanTreeError, got ${err}`);
		assert.match(err.message, needle);
		return;
	}
	assert.fail(`expected a PlanTreeError matching ${needle}, but the op succeeded`);
}

// ─── 1. pure ops ─────────────────────────────────────────────────────────────

describe("plan-tree pure ops", () => {
	it("createTree builds version 1 with no mutation of its inputs", () => {
		const nodes = [N("a", "A"), N("b", "B")];
		const edges = [E("a", "b")];
		const t = createTree(nodes, edges);
		assert.equal(t.version, 1);
		assert.ok(!("currentNodeId" in t), "no stored progress — structure only");
		assert.ok(!("doneNodeIds" in t), "no done ledger of any kind");
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(t.edges, [E("a", "b")]);
		// Input arrays untouched (deep-copied into the tree).
		assert.deepEqual(nodes, [N("a", "A"), N("b", "B")]);
		assert.deepEqual(edges, [E("a", "b")]);
	});

	it("createTree rejects duplicate node ids", () => {
		assertReject(() => createTree([N("a"), N("a")], []), /Duplicate node id "a"/);
	});

	it("createTree rejects edges with missing endpoints", () => {
		assertReject(() => createTree([N("a")], [E("a", "ghost")]), /unknown node id "ghost"/);
		assertReject(() => createTree([N("a")], [E("ghost", "a")]), /unknown node id "ghost"/);
	});

	it("createTree rejects self-loops, duplicates, and cycles", () => {
		assertReject(() => createTree([N("a")], [E("a", "a")]), /self-loop/);
		assertReject(() => createTree([N("a"), N("b")], [E("a", "b"), E("a", "b")]), /already exists/);
		// a→b→c→a is a cycle.
		assertReject(
			() => createTree([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c"), E("c", "a")]),
			/cycle/,
		);
	});

	it("createTree rejects invalid node shapes", () => {
		assertReject(() => createTree([N("")], []), /non-empty `id`/);
		assertReject(() => createTree([{ id: "a", title: "" }], []), /non-empty `title`/);
	});

});

// ─── 2. tool execute against the real store ─────────────────────────────────

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

/** Call a plan tool's execute directly with a minimal execution-options object. */
async function exec(tools: ReturnType<typeof planTools>, name: string, input: unknown): Promise<PlanToolResult> {
	const t = tools[name]!;
	assert.ok(typeof t.execute === "function", `${name} must be a server-side tool with execute`);
	return t.execute("test", input).then((r) => r.details as PlanToolResult);
}

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

describe("plan_init — the author-once mermaid tool (execute against the real store)", () => {
	it("applies a plan title after the tree is durable, announces it, and keeps sidebar ordering", async () => {
		const chatId = newChat("I want to learn this but don't know where to start");
		const before = chatStore.getChat(chatId)!;
		const snapshots: typeof before[] = [];
		const off = subscribe((event) => {
			if (event.type === "chats-changed") snapshots.push(chatStore.getChat(chatId)!);
		});
		try {
			const res = await exec(planTools({ chatId, chatStore }), "plan_init", {
				mermaid: "graph TD\n  functions[Functions] --> decorators[Python decorators]",
				title: "  Python\n decorators  ",
			});
			assert.equal(res.ok, true);
			assert.equal(snapshots.length, 1);
			assert.equal(snapshots[0]!.title, "Python decorators");
			assert.equal(snapshots[0]!.titleSource, "plan");
			assert.deepEqual(snapshots[0]!.tree, res.tree);
			assert.equal(snapshots[0]!.updatedAt, before.updatedAt);
			assert.equal(chatStore.listChats().find((chat) => chat.id === chatId)!.title, "Python decorators");
		} finally { off(); }
	});

	it("preserves manual titles, including a rename to the original text, and legacy titles", async () => {
		for (const source of ["manual", "legacy"] as const) {
			const chatId = newChat("My chosen title");
			const tools = planTools({ chatId, chatStore });
			if (source === "manual") chatStore.renameChat(chatId, "My chosen title");
			else {
				const record = chatStore.getChat(chatId)!;
				delete record.titleSource;
				fs.writeFileSync(path.join(PATHS.chats, `${chatId}.json`), JSON.stringify(record));
			}
			const res = await exec(tools, "plan_init", {
				mermaid: "graph TD\n  a[Decorators]", title: "Python decorators",
			});
			assert.equal(res.ok, true);
			assert.equal(chatStore.getChat(chatId)!.title, "My chosen title");
		}
	});

	it("keeps the first generated title on plan rewrites and still permits manual rename", async () => {
		const chatId = newChat("Initial request");
		const tools = planTools({ chatId, chatStore });
		await exec(tools, "plan_init", { mermaid: "graph TD\n  a[装饰器]", title: "Python 装饰器" });
		await exec(tools, "plan_init", { mermaid: "graph TD\n  b[闭包]", title: "Closures" });
		assert.equal(chatStore.getChat(chatId)!.title, "Python 装饰器");
		chatStore.renameChat(chatId, "My Python notes");
		await exec(tools, "plan_init", { mermaid: "graph TD\n  c[Functions]", title: "Functions" });
		assert.equal(chatStore.getChat(chatId)!.title, "My Python notes");
		assert.equal(chatStore.getChat(chatId)!.titleSource, "manual");
	});

	it("missing or blank titles leave the plan usable and allow a later title", async () => {
		const chatId = newChat("Original title");
		const tools = planTools({ chatId, chatStore });
		for (const title of [undefined, " \n "]) {
			const res = await exec(tools, "plan_init", { mermaid: "graph TD\n  a[Functions]", title });
			assert.equal(res.ok, true);
			assert.equal(chatStore.getChat(chatId)!.title, "Original title");
			assert.equal(chatStore.getChat(chatId)!.titleSource, "prompt");
		}
		await exec(tools, "plan_init", { mermaid: "graph TD\n  a[Functions]", title: "Python functions" });
		assert.equal(chatStore.getChat(chatId)!.title, "Python functions");
	});

	it("rejects invalid plans without renaming and isolates title-write failures from valid plans", async () => {
		const chatId = newChat("Keep this title");
		const tools = planTools({ chatId, chatStore });
		const invalid = await exec(tools, "plan_init", { mermaid: "graph TD\n  a[A] --> b[B] --> a", title: "Invalid plan" });
		assert.equal(invalid.ok, false);
		assert.equal(chatStore.getChat(chatId)!.title, "Keep this title");
		assert.equal(chatStore.getChat(chatId)!.tree, undefined);
		const failing = planTools({ chatId, chatStore: {
			...chatStore, renameChatFromPlan: () => { throw new Error("Simulated title write failure"); },
		} });
		const valid = await exec(failing, "plan_init", { mermaid: "graph TD\n  a[Functions]", title: "Functions" });
		assert.equal(valid.ok, true);
		assert.deepEqual(chatStore.getChat(chatId)!.tree, valid.tree);
		assert.equal(chatStore.getChat(chatId)!.title, "Keep this title");
	});

	it("parses a mermaid block, builds the tree, persists, returns the full tree", async () => {
		const chatId = newChat("Plan: init");
		const tools = planTools({ chatId, chatStore });

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  primitives[Number primitives] --> operators[Arithmetic operators]\n  operators --> expressions[Evaluating expressions]\n  detour[Side quest]\n",
		});
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		const tree = res.tree!;
		assert.equal(tree.version, 1);
		assert.deepEqual(
			tree.nodes.map((n) => n.id),
			["primitives", "operators", "expressions", "detour"],
		);
		assert.deepEqual(tree.edges, [
			{ from: "primitives", to: "operators" },
			{ from: "operators", to: "expressions" },
		]);

		const saved = chatStore.getChat(chatId)!.tree;
		assert.ok(saved, "tree persisted to the chat record");
		assert.deepEqual(saved, tree);
	});

	it("RE-CALLABLE: a rewrite replaces the tree wholesale (the mutation tools are gone)", async () => {
		const chatId = newChat("Plan: rewrite");
		const tools = planTools({ chatId, chatStore });
		await exec(tools, "plan_init", {
			mermaid: "graph TD\n  a[First attempt] --> b[Early shape]\n",
		});

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  truth[The core truth]\n  goal[The sink] --> truth\n",
		});
		assert.equal(res.ok, true, "re-init is the sanctioned rewrite path now");
		assert.deepEqual(
			res.tree!.nodes.map((n) => n.id),
			["truth", "goal"],
		);
		assert.deepEqual(
			chatStore.getChat(chatId)!.tree!.nodes.map((n) => n.id),
			["truth", "goal"],
			"rewrite persisted",
		);
	});

	it("parse failures collect EVERY problem with line numbers and persist nothing", async () => {
		const chatId = newChat("Plan: bad parse");
		const tools = planTools({ chatId, chatStore });

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  Foo Bar[x] --> y\n  a --> a\n  subgraph hi\n",
		});
		assert.equal(res.ok, false);
		const err = res.error!;
		assert.match(err, /line 2/);
		assert.match(err, /line 3/);
		assert.match(err, /line 4/);
		// Context diet (2026-10-09): failures carry just the error — no tree echo.
		assert.equal(res.tree, undefined);
		assert.equal(chatStore.getChat(chatId)!.tree, undefined, "nothing persisted on failure");
	});

	it("structural failures (cycle) become ok:false without persisting", async () => {
		const chatId = newChat("Plan: cycle");
		const tools = planTools({ chatId, chatStore });
		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  a[A] --> b[B]\n  b --> a\n",
		});
		assert.equal(res.ok, false);
		assert.match(res.error!, /cycle/);
		assert.equal(res.tree, undefined, "no tree echo on failure (context diet, 2026-10-09)");
	});

	it("only plan_init exists — the seven mutation/tracking tools are gone by design", () => {
		const tools = planTools({ chatId: "chat_x", chatStore });
		assert.deepEqual(Object.keys(tools), ["plan_init"]);
	});

	it("unknown chat returns ok:false with the empty tree", async () => {
		const tools = planTools({ chatId: "chat_nonexistent", chatStore });
		const res = await exec(tools, "plan_init", { mermaid: "graph TD\n  a[A]\n" });
		assert.equal(res.ok, false);
		assert.match(res.error!, /Chat not found/);
		assert.equal(res.tree, undefined);
	});
});

// ─── the mermaid subset parser ────────────────────────────────────────────────

describe("parseMermaidPlan (the constrained mermaid subset)", () => {
	const parse = (m: string) => parseMermaidPlan(m);

	it("accepts graph TD and flowchart TB headers (case-insensitive), comments, and blank lines", () => {
		for (const header of ["graph TD", "graph td", "flowchart TB", "Flowchart td"]) {
			const res = parse(`${header}\n%% a comment\n\n  a[Alpha]\n`);
			assert.equal(res.ok, true, header);
			assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "Alpha" }]);
		}
	});

	it("bare ids fall back to id-as-title; bracket and paren labels both work", () => {
		const res = parse("graph TD\n  bare\n  bracket[Bracket title]\n  paren(\"Paren title\")\n");
		assert.deepEqual(res.plan!.nodes, [
			{ id: "bare", title: "bare" },
			{ id: "bracket", title: "Bracket title" },
			{ id: "paren", title: "Paren title" },
		]);
	});

	it("edges register bare endpoints as nodes and dedupe duplicate edges", () => {
		const res = parse("graph TD\n  a --> b[Bee]\n  a --> b[Bee]\n");
		assert.deepEqual(res.plan!.nodes, [
			{ id: "a", title: "a" },
			{ id: "b", title: "Bee" },
		]);
		assert.deepEqual(res.plan!.edges, [{ from: "a", to: "b" }]);
	});

	it("labels on both edge endpoints survive; forward references are fine", () => {
		const res = parse("graph TD\n  downstream[Later thing] --> upstream[Earlier thing]\n");
		assert.deepEqual(res.plan!.edges, [{ from: "downstream", to: "upstream" }]);
		assert.deepEqual(res.plan!.nodes, [
			{ id: "downstream", title: "Later thing" },
			{ id: "upstream", title: "Earlier thing" },
		]);
	});

	it("rejects: non-slug ids (with the SPECIFIC message), self-loops, subgraphs, missing header, empty", () => {
		// The muscle-protein post-mortem (2026-09-11): underscore ids died at
		// the regex layer with a generic message, and the teacher spent four
		// plan_init calls hunting punctuation the parser didn't care about.
		// Now EVERY bad id reaches the slug check — the message names the id.
		assert.ok(!parse("graph TD\n  Foo Bar[x]\n").ok, "id with a space");
		assert.match(parse("graph TD\n  Foo Bar[x]\n").problems[0]!, /line 2.*slug/);
		assert.match(parse("graph TD\n  mps.translation[x]\n").problems[0]!, /node id `mps.translation` must be a lowercase slug/);
		assert.match(parse("graph TD\n  MPS[x]\n").problems[0]!, /node id `MPS` must be a lowercase slug/);
		assert.match(
			parse("graph TD\n  a[Alpha] --> mps.translation[Beta]\n").problems[0]!,
			/node id `mps.translation` must be a lowercase slug/,
			"bad id inside an edge also gets the specific message",
		);
		assert.ok(!parse("graph TD\n  a --> a\n").ok, "self-loop");
		assert.ok(!parse("graph TD\n  subgraph cluster\n").ok, "subgraph");
		assert.ok(!parse("digraph G\n  a\n").ok, "wrong header");
		assert.ok(!parse("%% only a comment\n").ok, "empty plan");
	});

	it("free-form pass (2026-09-11): underscores, chains, arrow synonyms, any direction, quoted titles", () => {
		// Underscores are first-class slug chars — kept verbatim, referenced
		// verbatim by quiz nodeId.
		const us = parse("graph TD\n  mps_translation[Ribosomes build protein] --> net_balance[Net balance]\n");
		assert.ok(us.ok, "underscore ids");
		assert.deepEqual(us.plan!.nodes, [
			{ id: "mps_translation", title: "Ribosomes build protein" },
			{ id: "net_balance", title: "Net balance" },
		]);
		// The exact shape the muscle-protein teacher wrote (attempt 1):
		// quoted titles with colons, commas, equals signs — must just work.
		const quoted = parse(
			'graph TD\n  mps_translation["MPS = ribosomes building protein"] --> per_meal["Per-meal dose: ~20-40 g saturates, excess oxidized"]\n',
		);
		assert.ok(quoted.ok, "quoted punctuation-rich titles");
		assert.deepEqual(quoted.plan!.nodes, [
			{ id: "mps_translation", title: "MPS = ribosomes building protein" },
			{ id: "per_meal", title: "Per-meal dose: ~20-40 g saturates, excess oxidized" },
		]);
		// Chains expand to consecutive pairs.
		const chain = parse("graph TD\n  a[Alpha] --> b[Bee] --> c[See]\n");
		assert.ok(chain.ok, "chained edges");
		assert.deepEqual(chain.plan!.edges, [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		]);
		// Arrow synonyms ==>, -.-> mean the same as -->.
		for (const arrow of ["==>", "-.->"]) {
			const res = parse(`graph TD\n  a ${arrow} b\n`);
			assert.ok(res.ok, arrow);
			assert.deepEqual(res.plan!.edges, [{ from: "a", to: "b" }]);
		}
		// Any direction header (we layout ourselves).
		for (const header of ["graph LR", "flowchart RL", "graph BT"]) {
			assert.ok(parse(`${header}\n  a --> b\n`).ok, header);
		}
	});

	it("the first label wins when a node line repeats (relabeling mid-block is ignored)", () => {
		const res = parse("graph TD\n  a[First label]\n  a[Second label]\n");
		assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "First label" }]);
	});
});

// ─── derived statuses: position from CALLS, never results (§3) ─────────────────

describe("derivePlanStatuses (the map tracks position, not completion)", () => {
	const tree: PlanTree = {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
			{ id: "c", title: "C" },
		],
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		],
		version: 1,
	};
	const quizPart = (state: string, nodeId: string | undefined, correct?: boolean) => ({
		type: "tool-quiz",
		state,
		input: nodeId === undefined ? {} : { nodeId },
		...(correct === undefined ? {} : { output: { correct } }),
	});
	type QuizPart = { type: string; state: string; input: unknown; output?: unknown };
	const msg = (...parts: QuizPart[]) => ({ parts });

	it("empty transcript → no current, nothing visited (no fallback current)", () => {
		const st = derivePlanStatuses(tree, []);
		assert.equal(st.current, null);
		assert.equal(st.visited.size, 0);
	});

	it("current = the node of the most recent tagged CALL — regardless of state or outcome", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "b", false))]);
		assert.equal(st.current, "b", "even a FAILED check positions the map: the tag is about, not completion");
		assert.equal(st.visited.size, 0);
		const open = derivePlanStatuses(tree, [msg(quizPart("input-available", "c"))]);
		assert.equal(open.current, "c", "a merely ASKED question is already the position");
	});

	it("visited = earlier tagged nodes, sticky; results feed nothing", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
		]);
		assert.equal(st.current, "b");
		assert.deepEqual([...st.visited], ["a"]);
		// a passed check never marks anything finished — only moving on does
		const again = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", true))]);
		assert.equal(again.current, "a");
		assert.equal(again.visited.size, 0, "one correct answer on a does not finish it");
	});

	it("revisits keep both: A→B→A gives current A, visited {A,B}", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
			msg(quizPart("input-available", "a")),
		]);
		assert.equal(st.current, "a");
		assert.deepEqual([...st.visited].sort(), ["a", "b"]);
	});

	it("several checks on one node hold the map still", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "a", false)),
			msg(quizPart("input-available", "a")),
		]);
		assert.equal(st.current, "a");
		assert.equal(st.visited.size, 0);
	});

	it("untagged checks and unknown nodeIds are ad-hoc — they move nothing", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", undefined, true)),
			msg(quizPart("output-available", "ghost", true)),
		]);
		assert.equal(st.current, null);
		assert.equal(st.visited.size, 0);
	});

	it("a rewritten map derives against the CURRENT tree — dropped slugs stop counting", () => {
		const rewritten: PlanTree = { ...tree, nodes: [tree.nodes[0]!, tree.nodes[1]!] };
		const st = derivePlanStatuses(rewritten, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "c", true)), // c removed by the rewrite
		]);
		assert.equal(st.current, "a", "the orphaned tag is ignored");
		assert.equal(st.visited.size, 0);
	});

	it("derivedNodeStatus: current wins over visited; upcoming otherwise", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", true))]);
		assert.equal(derivedNodeStatus(st, "a"), "current");
		assert.equal(derivedNodeStatus(st, "b"), "upcoming");
		const later = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
		]);
		assert.equal(derivedNodeStatus(later, "a"), "visited");
		assert.equal(derivedNodeStatus(later, "b"), "current");
		assert.equal(derivedNodeStatus(later, "c"), "upcoming");
	});
});

// ─── the explain mechanic derives position identically (owner 2026-09-27) ──

describe("derivePlanStatuses: tagged explain calls move the map like quiz calls", () => {
	const tree: PlanTree = {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
		],
		edges: [{ from: "a", to: "b" }],
		version: 1,
	};
	const explainPart = (nodeId: string | undefined) => ({
		type: "tool-explain",
		state: "output-available",
		input: nodeId === undefined ? {} : { nodeId },
	});
	type Part = { type: string; state: string; input: unknown; output?: unknown };
	const msg = (...parts: Part[]) => ({ parts });

	it("a tagged explain call is the current position; earlier ones are visited", () => {
		const st = derivePlanStatuses(tree, [
			msg(explainPart("a")),
			msg(explainPart("b")),
		]);
		assert.equal(st.current, "b");
		assert.deepEqual([...st.visited], ["a"]);
	});

	it("untagged explain calls move nothing", () => {
		const st = derivePlanStatuses(tree, [msg(explainPart(undefined))]);
		assert.equal(st.current, null);
		assert.equal(st.visited.size, 0);
	});

	it("mixed mechanics (an old quiz record, then an explain) still derive one run", () => {
		const st = derivePlanStatuses(tree, [
			msg({ type: "tool-quiz", state: "output-available", input: { nodeId: "a" } }),
			msg(explainPart("b")),
		]);
		assert.equal(st.current, "b");
		assert.deepEqual([...st.visited], ["a"]);
	});
});

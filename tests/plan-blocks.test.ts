/**
 * plan-blocks — the INTERIM plan presentation seam (docs/archive/probe-teach-split.md
 * §6): the full block renders IN FLOW exactly once, attached to the
 * assistant group carrying the successful plan_init call. Wave B: emission
 * is a NATIVE plan-block marker (one per TURN, for the last successful
 * call), and the one-way projection splices its data part right after the
 * last successful plan_init tool part. The neighborhood-block machinery is
 * retired (position derives live from derivePlanStatuses); the persistent
 * DAG window (UI wave) succeeds this.
 */
import assert from "node:assert";
import test from "node:test";
import type { PlanTree } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { planBlocksFor } from "../src/core/plan-blocks.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type { PlanBlockData } from "../src/core/contracts.ts";

// 5-node fixture: a → b → c, b → d, d → e.
const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "A" },
		{ id: "b", title: "B" },
		{ id: "c", title: "C" },
		{ id: "d", title: "D" },
		{ id: "e", title: "E" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "b", to: "d" },
		{ from: "d", to: "e" },
	],
	version: 1,
};

/** A rewrite fixture: 3 fresh nodes (x, y, z), different from TREE. */
const TREE2: PlanTree = {
	nodes: [
		{ id: "x", title: "X" },
		{ id: "y", title: "Y" },
		{ id: "z", title: "Z" },
	],
	edges: [{ from: "x", to: "y" }, { from: "y", to: "z" }],
	version: 2,
};

/** A native assistant message with one tool call (the projection's tool
 *  part source) — minimal fixture shape, same as the record holds. */
function assistantWithCall(id: string, name: string, args: unknown, ...text: string[]): LhMessage {
	const content: unknown[] = [];
	for (const t of text) content.push({ type: "text", text: t });
	content.push({ type: "toolCall", id: `call_${id}`, name, arguments: args as never });
	return {
		id,
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

/** A native tool result for a call (details = what the record + projection
 *  read; the plan tool persists {ok, tree} here). */
function resultOf(callId: string, toolName: string, details: unknown, isError = false): LhMessage {
	return {
		id: `r_${callId}${isError ? "_e" : ""}`,
		role: "toolResult",
		toolCallId: `call_${callId}`,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		details,
		isError,
		timestamp: Date.now(),
	} as never;
}

/** Emit + persist + project: the full persistTurn slice for a turn whose
 *  new messages are `turn`, run over `record`. Returns the projection of
 *  the whole record after the write. */
function projectAfter(record: LhMessage[], turn: LhMessage[], tree: PlanTree | null) {
	// Wave D: the status derivation reads the NATIVE transcript.
	const blocks = planBlocksFor(record, turn, tree, [...record, ...turn]);
	return projectNative([...record, ...turn, ...blocks]);
}

function blocksOf(messages: ReturnType<typeof projectNative>): PlanBlockData[] {
	return messages.flatMap((m) =>
		(m.parts as { type: string; data?: PlanBlockData }[])
			.filter((p) => p.type === "data-plan-block")
			.map((p) => p.data!),
	);
}

test("a successful plan_init turn gains ONE full block (all nodes, statuses from the transcript)", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }, "Here is the plan."),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	const out = projectAfter([], turn, TREE);
	const blocks = blocksOf(out);
	assert.equal(blocks.length, 1);
	const data = blocks[0]!;
	assert.equal(data.kind, "full");
	assert.equal(data.current, null, "at authoring nothing is current");
	assert.equal(data.nodes.length, 5);
	assert.ok(data.nodes.every((n) => n.status === "upcoming"));
	assert.equal(data.edges.length, 4);
});

test("a FAILED plan_init gains nothing", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }, "oops"),
		resultOf("m1", "plan_init", { ok: false, error: "bad" }, true),
	];
	assert.equal(blocksOf(projectAfter([], turn, TREE)).length, 0);
});

test("idempotent — a call whose block the record already carries is never re-emitted", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	const first = projectAfter([], turn, TREE);
	assert.equal(blocksOf(first).length, 1);
	// Persist replay: the same turn's messages land again over a record
	// that already emitted the marker → no duplicate.
	const record: LhMessage[] = [...turn, ...planBlocksFor([], turn, TREE, turn)];
	const blocks2 = planBlocksFor(record, turn, TREE, record);
	assert.equal(blocks2.length, 0, "no duplicate block on persist replay");
});

test("a plan REWRITE (a later turn's successful plan_init) gets its own full block; the old stays frozen", () => {
	const first = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	const record = [...first, ...planBlocksFor([], first, TREE, first)];
	const second = [
		assistantWithCall("m2", "plan_init", { tree: TREE2 }),
		resultOf("m2", "plan_init", { ok: true, tree: TREE2 }),
	];
	const out = projectAfter(record, second, TREE2);
	const blocks = blocksOf(out);
	assert.equal(blocks.length, 2, "one full block per authoring turn");
	assert.equal(blocks[1]!.nodes.length, 3);
});

test("the block renders IN FLOW immediately after the plan_init part — not appended under the turn's later parts", () => {
	// Real-world shape (user session chat_mtwgb9lj): the authoring turn
	// carries plan_init + prose + a quiz call — emission runs at persistTurn
	// AFTER all of that exists.
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
		assistantWithCall("m1b", "quiz", { question: "q?" }, "Here's the plan."),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }), // (kept out via emitted set — see next test)
	];
	turn.pop(); // drop the stray duplicate — build the real shape below
	const real = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
		assistantWithCall("m1b", "quiz", { question: "q?" }, "Here's the plan."),
	];
	const out = projectAfter([], real, TREE);
	const group = out.find((m) => m.role === "assistant")!;
	const types = (group.parts as unknown[]).map((p) => (p as { type: string }).type);
	const blockAt = types.indexOf("data-plan-block");
	assert.ok(blockAt > types.indexOf("tool-plan_init"), "the block directly follows the plan_init part");
	assert.ok(blockAt < types.indexOf("text"), "block before the prose");
	assert.ok(blockAt < types.indexOf("tool-quiz"), "block before the first check");
	assert.equal(types.at(-1), "tool-quiz", "the quiz is still the turn's last part");
});

test("with multiple plan_inits in one turn (a same-turn rewrite), ONE block follows the LAST one", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }, "v1"),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
		assistantWithCall("m2", "plan_init", { tree: TREE2 }, "v2"),
		resultOf("m2", "plan_init", { ok: true, tree: TREE2 }),
	];
	const out = projectAfter([], turn, TREE2);
	const group = out.find((m) => m.role === "assistant")!;
	const parts = group.parts as unknown[];
	const blocks = parts.filter((p) => (p as { type: string }).type === "data-plan-block");
	assert.equal(blocks.length, 1, "one block per turn even on a same-turn rewrite");
	const types = parts.map((p) => (p as { type: string }).type);
	assert.ok(
		types.indexOf("data-plan-block") > types.indexOf("tool-plan_init"),
		"the block follows the last successful init",
	);
});

test("quizzes alone emit nothing (no neighborhood blocks anymore)", () => {
	const turn = [
		assistantWithCall("m1", "quiz", { nodeId: "b", question: "q?" }),
		resultOf("m1", "quiz", { correct: true }),
	];
	assert.equal(blocksOf(projectAfter([], turn, TREE)).length, 0);
});

test("no tree / empty tree / no messages are no-ops", () => {
	const turn = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	assert.equal(planBlocksFor([], turn, null, []).length, 0, "no tree → nothing");
	const emptyTree: PlanTree = { nodes: [], edges: [], version: 0 };
	assert.equal(planBlocksFor([], turn, emptyTree, []).length, 0, "empty tree → nothing");
	assert.equal(planBlocksFor([], [], TREE, []).length, 0, "no messages → nothing");
});

test("mid-lesson rewrite snapshot derives statuses from the whole transcript", () => {
	// A tagged quiz call on node b happened before the rewrite: b is current.
	const before = [
		assistantWithCall("m0", "quiz", { nodeId: "b", question: "q?" }),
		resultOf("m0", "quiz", { correct: true }),
	];
	const rewrite = [
		assistantWithCall("m1", "plan_init", { tree: TREE }),
		resultOf("m1", "plan_init", { ok: true, tree: TREE }),
	];
	const out = projectAfter(before, rewrite, TREE);
	const data = blocksOf(out)[0]!;
	assert.equal(data.current, "b");
	const b = data.nodes.find((n) => n.id === "b")!;
	assert.equal(b.status, "current");
});

/**
 * The agent-split question tools (docs/probe-teach-split.md §1):
 *
 *  - teachQuizToolFor — the TEACHER's quiz: the shared authoring contract +
 *    the per-session plan-nodeId validation (position signal; a mismatched id
 *    is rejected at the call boundary and returns to the agent to fix).
 *  - createProberTools — the PROBER's quiz has NO nodeId field at all (the
 *    schema is built from quizInputBase; the key is stripped if the model
 *    tries anyway), plus ask + probe_done.
 *
 * The grading contract (question-core) is shared and untouched by both.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	probeQuizTool,
	probeExplainTool,
	quizExampleBody,
	teachExplainToolFor,
	teachQuizToolFor,
	type TeacherToolContext,
} from "../src/agent/tools.ts";
import { TOGGLEABLE_TOOLS } from "../src/core/pending.ts";
import { jobStore } from "../src/store/jobs.ts";
import { probeQuizInputSchema, quizInputObject, quizInputProblems } from "../src/core/question-core.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const dataDir = path.join(PATHS.root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

const validQuiz = {
	question: "What is 2 + 2?",
	options: [
		{ label: "3", value: "3" },
		{ label: "4", value: "4" },
	],
	correctAnswer: "4",
	explanation: "Arithmetic.",
	type: "check",
	nodeId: "arith",
};

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** The Wave A boundary predicate (2026-09-26): pi's loop structurally
 *  validates against the TypeBox parameters, then execute re-runs the
 *  authoring refinements (the old superRefine) and returns an isError
 *  result on problems (pi 1.0 convention — invalidInputResult; the model
 *  sees both as retryable input errors). This helper replicates the old
 *  safeParse seam end to end. */
async function boundaryParse(
	// `input: never` param: contravariance lets any AgentTool's execute slot in.
	tool: { parameters: any; execute: (id: string, input: never) => Promise<unknown> },
	input: unknown,
): Promise<{ success: boolean; error?: AgentToolResult<{ tool: string; problems: string[] }> }> {
	if (!Value.Check(tool.parameters, input)) return { success: false };
	const result = (await tool.execute("tc", input as never)) as AgentToolResult<{
		tool: string;
		problems: string[];
	}>;
	if (result.isError) return { success: false, error: result };
	return { success: true };
}
const problemLines = (r?: AgentToolResult<{ tool: string; problems: string[] }>): string[] =>
	r?.details.problems ?? [];

describe("teachQuizToolFor: the dynamic plan-nodeId validation (position signal)", () => {
	it("accepts a nodeId that matches a node of the session's tree", async () => {
		const chatId = newChat("NodeId: valid");
		chatStore.saveTree(chatId, {
			nodes: [
				{ id: "arith", title: "Arithmetic" },
				{ id: "expressions", title: "Expressions" },
			],
			edges: [{ from: "arith", to: "expressions" }],
			version: 1,
		});
		const res = await boundaryParse(teachQuizToolFor({ chatId, chatStore }), {
			...validQuiz,
			nodeId: "expressions",
		});
		assert.equal(res.success, true);
	});

	it("rejects a nodeId that matches no node — with a message listing the slugs", async () => {
		const chatId = newChat("NodeId: typo");
		chatStore.saveTree(chatId, {
			nodes: [{ id: "arith", title: "Arithmetic" }],
			edges: [],
			version: 1,
		});
		const res = await boundaryParse(teachQuizToolFor({ chatId, chatStore }), {
			...validQuiz,
			nodeId: "arithmetic", // the typo — slug is 'arith'
		});
		assert.equal(res.success, false);
		const msg = problemLines(res.error).join("\n");
		assert.match(msg, /matches no node/);
		assert.match(msg, /arith/);
	});

	it("no tree yet: ANY nodeId is rejected — quizzes wait for plan_init", async () => {
		const chatId = newChat("NodeId: no tree");
		const tool = teachQuizToolFor({ chatId, chatStore });
		const res = await boundaryParse(tool, { ...validQuiz, nodeId: "anything" });
		assert.equal(res.success, false);
		assert.match(problemLines(res.error).at(-1)!, /No plan map exists yet — call plan_init/);
	});

	it("missing nodeId is rejected at the boundary (owner ruling 2026-09-26: no untagged quizzes)", async () => {
		const chatId = newChat("NodeId: required");
		chatStore.saveTree(chatId, {
			nodes: [{ id: "arith", title: "Arithmetic" }],
			edges: [],
			version: 1,
		});
		const tool = teachQuizToolFor({ chatId, chatStore });
		const { nodeId: _dropped, ...untagged } = validQuiz;
		const res = await boundaryParse(tool, untagged);
		assert.equal(res.success, false, "an untagged quiz must be rejected back to the model");
		// The structural pin: the SCHEMA itself names the missing field (pi's
		// boundary formats Value.Errors as the tool-input-error the model sees).
		const schemaErrors = [...Value.Errors(quizInputObject, untagged)].map((e) => e.message);
		assert.match(
			schemaErrors.join("\n"),
			/nodeId/,
			"the schema rejection names nodeId so the model can retry tagged",
		);
	});

	it("reads the LIVE record — a plan_init mutation mid-turn is honored immediately", async () => {
		const chatId = newChat("NodeId: live record");
		const tool = teachQuizToolFor({ chatId, chatStore });

		const before = await boundaryParse(tool, { ...validQuiz, nodeId: "fresh-node" });
		assert.equal(before.success, false, "no tree yet → rejected");

		chatStore.saveTree(chatId, {
			nodes: [{ id: "fresh-node", title: "Just initialized" }],
			edges: [],
			version: 1,
		});
		const after = await boundaryParse(tool, { ...validQuiz, nodeId: "fresh-node" });
		assert.equal(after.success, true, "the same id validates once the tree exists — same turn");
	});

	it("the shared grading rules still chain FIRST (schema-valid ⇔ gradeable)", async () => {
		const chatId = newChat("NodeId: grading rules intact");
		const res = await boundaryParse(teachQuizToolFor({ chatId, chatStore }), {
			...validQuiz,
			correctAnswer: "42", // matches no option — question-core's rule
			nodeId: "ghost", // also bad — BOTH problems surface
		});
		assert.equal(res.success, false);
		const msgs = problemLines(res.error).join("\n");
		assert.match(msgs, /correctAnswer/);
		assert.match(msgs, /matches no node/);
	});
});

describe("the prober's quiz: no nodeId field at all", () => {
	it("the probe schema accepts a plain quiz; a smuggled nodeId is NOT in the wire schema", () => {
		assert.ok(Value.Check(probeQuizInputSchema, validQuiz));
		// Wave A delta (2026-09-26): pi's TypeBox validation tolerates unknown
		// keys rather than stripping them — but the probe schema's wire
		// properties carry no nodeId at all, and the display parse seam
		// (tool-parts parseQuizInput, Value.Clean) strips it before the dock.
		const smuggled = { ...validQuiz, nodeId: "anything" };
		assert.ok(Value.Check(probeQuizInputSchema, smuggled));
		const wireKeys = Object.keys((probeQuizInputSchema as { properties: Record<string, unknown> }).properties);
		assert.ok(!wireKeys.includes("nodeId"), "no session check to fail — the field isn't the prober's to set");
		assert.equal("nodeId" in (Value.Clean(probeQuizInputSchema, smuggled) as object), false, "the dock parse strips it");
	});

	it("the prober's tool registry carries the nodeId-less quiz, probe_done, and the learner-filesystem set", () => {
		const chatId = newChat("Prober: registry");
		const tools = createProberTools({ chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} });
		// Fix wave (2026-09-20): the owner ruling adds research + pdf dispatch
		// to the probe phase's registry (demo/visual stay teach-only).
		assert.deepEqual(Object.keys(tools).sort(), [
			"ask_user_question", "find", "grep", "ls", "pdf", "probe", "probe_done", "read", "research",
		]);
		const probe = tools.probe as AgentTool<any>;
		assert.equal(Value.Check(probe.parameters, { ...validQuiz, nodeId: "anything" }), true, "no session check to fail");
	});
});
// ─── the description example (owner, 2026-10-12) ─────────────────────────

describe("quiz tool descriptions carry the complete, phase-correct example", () => {
	it("the canonical body is schema-valid and authoring-clean (never ship a broken exemplar)", () => {
		assert.deepEqual(quizInputProblems(quizExampleBody), []);
		assert.equal(Value.Check(probeQuizInputSchema, quizExampleBody), true);
		const teachExample = { type: "check", nodeId: "chain-rule", ...quizExampleBody };
		assert.equal(Value.Check(quizInputObject, teachExample), true);
	});

	it("probe: the serialized body rides the description with correct JSON escaping, no phase metadata", () => {
		const desc = probeQuizTool.description;
		assert.ok(
			desc.includes("```json\n" + JSON.stringify(quizExampleBody, null, 2) + "\n```"),
			"the example is the exact JSON.stringify of the canonical body",
		);
		// The escaping exemplar must be VISIBLE as wire text — the runtime
		// string carries literal double backslashes, exactly what the model
		// must type inside JSON.
		assert.ok(desc.includes("A signal is $y=\\\\sin(2x)$"), "LaTeX command backslash shows doubled");
		assert.ok(desc.includes("a LaTeX backslash is \\\\ and a newline is \\n"), "the one-line escaping hint");
		assert.ok(!desc.includes("nodeId"), "probe example carries no phase metadata");
	});

	it("quiz: the required pair leads the example, with the plan-id caveat", () => {
		const chatId = newChat("Teacher: description example");
		const desc = teachQuizToolFor({ chatId, chatStore }).description;
		const teachExample = { type: "check", nodeId: "chain-rule", ...quizExampleBody };
		assert.ok(desc.includes("```json\n" + JSON.stringify(teachExample, null, 2) + "\n```"));
		// The 2026-10-09 drop-order ruling: type+nodeId LEAD the object —
		// fields generated first get dropped least.
		assert.ok(
			/```json\n\{\n {2}"type": "check",\n {2}"nodeId": "chain-rule",/.test(desc),
			"type and nodeId lead the serialized example",
		);
		assert.ok(
			desc.includes("illustrative — copy an exact id from this session's plan_init"),
			"the illustrative-nodeId caveat",
		);
	});
});
// ─── tool availability (2026-09 settings seam) ───────────────────────────────

describe("tool toggles (core/pending.ts + factories)", () => {
	it("TOGGLEABLE_TOOLS: the sub-agent dispatch tools; quiz/ask/read stay off the list", () => {
		// THE DEFINITIVE vocabulary (adjudicated with the user 2026-09-19, P2
		// reconciliation): the job tools only. quiz/ask_user_question are
		// permanently always-on (the prober's assessment + teaching doctrine
		// are built on graded questions — the wedge danger), as are the
		// learner-fs set, plan tools, and probe_done. The settings WRITE side
		// validates against this list (settings-body).
		assert.deepEqual(TOGGLEABLE_TOOLS, ["research", "demo", "visual", "pdf"]);
	});

	it("createProberTools: absent record = full set; explicit false drops exactly that tool; probe_done survives everything", () => {
		const chatId = newChat("Prober: toggles");
		const ctx = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		assert.deepEqual(Object.keys(createProberTools(ctx)).sort(), [
			"ask_user_question", "find", "grep", "ls", "pdf", "probe", "probe_done", "read", "research",
		]);

		const noAsk = createProberTools(ctx, { ask_user_question: false });
		assert.deepEqual(Object.keys(noAsk).sort(), ["find", "grep", "ls", "pdf", "probe", "probe_done", "read", "research"]);

		// Quizzing is mechanics-managed now (owner 2026-09-27): quiz/explain
		// NEVER pass through the generic filter — hand-written quiz:false is a
		// no-op (the wedge danger stands: a quiz-less prober collapses its
		// assessment flow). probe_done is never droppable — it ends the phase.
		const noQuiz = createProberTools(ctx, { quiz: false });
		assert.deepEqual(Object.keys(noQuiz).sort(), ["ask_user_question", "find", "grep", "ls", "pdf", "probe", "probe_done", "read", "research"]);
		// The mechanic switch (owner 2026-09-27): tools.explain === true arms
		// free-recall — explain in, quiz out, exactly one quizzing tool.
		const free = createProberTools(ctx, { explain: true });
		assert.deepEqual(Object.keys(free).sort(), ["ask_user_question", "find", "grep", "ls", "pdf", "probe_done", "read", "recall", "research"]);
		assert.ok(createProberTools(ctx, { probe_done: false }).probe_done, "probe_done always-on");
	});

	it("createTeacherTools: {research: false} removes exactly research; unknown keys are no-ops", () => {
		const chatId = newChat("Teacher: toggles");
		const ctx: TeacherToolContext = {
			chatId,
			chatStore,
			jobStore,
			spawn: () => {},
		};
		const full = Object.keys(createTeacherTools(ctx)).sort();
		assert.deepEqual(full, ["ask_user_question", "curriculum", "demo", "find", "grep", "ls", "pdf", "plan_init", "quiz", "read", "research", "visual"]);

		const noResearch = Object.keys(createTeacherTools(ctx, { research: false })).sort();
		assert.deepEqual(noResearch, ["ask_user_question", "curriculum", "demo", "find", "grep", "ls", "pdf", "plan_init", "quiz", "read", "visual"]);

		// absent = enabled: an empty record and undefined behave identically
		assert.deepEqual(
			Object.keys(createTeacherTools(ctx, {})).sort(),
			full,
			"absent keys mean enabled — old records behave exactly as today",
		);

		// The mechanic switch (owner 2026-09-27): free-recall swaps the teach
		// quiz for the teach explain — one quizzing tool, whichever is armed.
		const freeFull = ["ask_user_question", "curriculum", "demo", "explain", "find", "grep", "ls", "pdf", "plan_init", "read", "research", "visual"];
		assert.deepEqual(Object.keys(createTeacherTools(ctx, { explain: true })).sort(), freeFull);
		assert.deepEqual(
			Object.keys(createTeacherTools(ctx, { explain: true, research: false })).sort(),
			freeFull.filter((t) => t !== "research"),
			"mechanics and plain toggles compose",
		);
	});
});


// ─── prepareArguments: the GLM string-encoded options guard (2026-09-26) ────

describe("prepareQuestionArguments (the string-encoded options wobble)", () => {
	// The gradient-descent session (chat_muhskq6p): 6 of 7 quiz validation
	// failures were `options` arriving as a JSON-encoded STRING. pi runs
	// prepareArguments BEFORE schema validation — the coerced call lands
	// instead of bouncing back as a wasted retry turn.
	const goodOptions = [
		{ label: "The slope of the tangent line", value: "slope" },
		{ label: "The value of the curve", value: "value" },
	];
	const asString = JSON.stringify(goodOptions);

	it("coerces string-encoded options on ALL THREE question tools", () => {
		for (const tool of [askUserQuestionTool, probeQuizTool, teachQuizToolFor({ chatId: "chat_x", chatStore: undefined as never })]) {
			const prepare = (tool as unknown as { prepareArguments?: (a: unknown) => unknown }).prepareArguments;
			assert.ok(prepare, `${tool.name} has the hook`);
			const out = prepare({ question: "q", options: asString, correctAnswer: "slope", explanation: "e" });
			assert.deepEqual(
				(out as { options: unknown }).options,
				goodOptions,
				`${tool.name} coerces the string to an array`,
			);
		}
	});

	it("passes everything else through UNTOUCHED (identity — pi's fast path)", () => {
		const prepare = (probeQuizTool as unknown as { prepareArguments: (a: unknown) => unknown }).prepareArguments;
		const arrayArgs = { question: "q", options: goodOptions, correctAnswer: "slope", explanation: "e" };
		assert.equal(prepare(arrayArgs), arrayArgs, "array args return the SAME object (no defensive copies)");
		const unparseable = { question: "q", options: "not json", correctAnswer: "slope", explanation: "e" };
		assert.equal(prepare(unparseable), unparseable, "unparseable strings pass through — validation reports honestly");
	});
});

// ─── the explain tool boundary (free-recall, owner 2026-09-27) ─────────────

describe("teachExplainToolFor: the explain variant validates nodeId like the quiz", () => {
	const validExplain = {
		question: "Explain why the null result matters.",
		correctAnswer: "It ruled out the aether — a stationary aether predicts a fringe shift, and none was seen.",
		nodeId: "arith",
		type: "check",
	};

	it("accepts a nodeId matching a tree node", async () => {
		const chatId = newChat("Explain nodeId: valid");
		chatStore.saveTree(chatId, {
			nodes: [
				{ id: "arith", title: "Arithmetic" },
				{ id: "expressions", title: "Expressions" },
			],
			edges: [{ from: "arith", to: "expressions" }],
			version: 1,
		});
		const res = await boundaryParse(teachExplainToolFor({ chatId, chatStore }), {
			...validExplain,
			nodeId: "expressions",
		});
		assert.equal(res.success, true);
	});

	it("rejects an off-map nodeId with the slugs listed", async () => {
		const chatId = newChat("Explain nodeId: typo");
		chatStore.saveTree(chatId, { nodes: [{ id: "arith", title: "A" }], edges: [], version: 1 });
		const res = await boundaryParse(teachExplainToolFor({ chatId, chatStore }), {
			...validExplain,
			nodeId: "arithmetic",
		});
		assert.equal(res.success, false);
		assert.match(problemLines(res.error).join("\n"), /matches no node/);
	});

	it("no tree yet: rejected — checks wait for plan_init", async () => {
		const chatId = newChat("Explain nodeId: no tree");
		const res = await boundaryParse(teachExplainToolFor({ chatId, chatStore }), validExplain);
		assert.equal(res.success, false);
		assert.match(problemLines(res.error).at(-1)!, /No plan map exists yet — call plan_init/);
	});

	it("an empty commitment is rejected at the boundary", async () => {
		const chatId = newChat("Explain: empty commitment");
		chatStore.saveTree(chatId, { nodes: [{ id: "arith", title: "A" }], edges: [], version: 1 });
		const res = await boundaryParse(teachExplainToolFor({ chatId, chatStore }), {
			...validExplain,
			correctAnswer: "   ",
		});
		assert.equal(res.success, false);
		assert.match(problemLines(res.error).join("\n"), /correctAnswer is required/);
	});
});

describe("the prober's explain: no nodeId field at all", () => {
	it("the probe schema carries no nodeId; the commitment contract still binds", async () => {
		assert.ok(!("nodeId" in probeExplainTool.parameters.properties));
		const res = await boundaryParse(probeExplainTool, {
			question: "Explain what a derivative measures.",
			correctAnswer: "The instantaneous rate of change at a point — the limit the slopes converge to.",
		});
		assert.equal(res.success, true);
		const empty = await boundaryParse(probeExplainTool, {
			question: "q",
			correctAnswer: " ",
		});
		assert.equal(empty.success, false);
	});
});

// ─── descriptions are MECHANICS (owner 2026-10-03) ────────────────────────
// Question-design doctrine lives in the system prompt (shared craft chunk +
// teacher fragments), NOT in tool descriptions. A description that teaches
// the model how to write questions drifts the moment a new variant (prober,
// future adaptive practice) reuses the tool with a different doctrine.
describe("tool descriptions carry mechanics only, no question-craft", () => {
	const teachQuiz = teachQuizToolFor({ chatId: "chat_x", chatStore: undefined as never });
	for (const [name, tool] of [
		["teach quiz", teachQuiz],
		["probe quiz", probeQuizTool],
	] as const) {
		it(`${name}: no craft doctrine, mechanics intact`, () => {
			const d = tool.description;
			for (const banned of ["asymmetry", "distractor", "believable", "misconception"]) {
				assert.ok(!d.toLowerCase().includes(banned), `${name} description leaks craft: "${banned}"`);
			}
			for (const mechanical of ["GRADED", "ONE question per turn", "ask_user_question"]) {
				assert.ok(d.includes(mechanical), `${name} description lost mechanics: "${mechanical}"`);
			}
		});
	}
	it("the teach quiz declares the `type` field and `nodeId`; the probe quiz declares neither", () => {
		assert.ok(teachQuiz.description.includes("`type`"), "teach quiz points at the role field");
		assert.ok(teachQuiz.description.includes("`nodeId`"), "teach quiz points at the plan-map validation");
		assert.ok(!probeQuizTool.description.includes("`type`"), "the probe quiz has no roles");
		assert.ok(!probeQuizTool.description.includes("`nodeId`"), "the probe quiz has no plan map");
	});
	it("the explain tools keep the COMMITMENT rule (the grading contract) and drop the softer doctrine", () => {
		for (const [name, tool] of [
			["teach explain", teachExplainToolFor({ chatId: "chat_x", chatStore: undefined as never })],
			["probe explain", probeExplainTool],
		] as const) {
			assert.ok(tool.description.includes("COMMITTED"), `${name} keeps the commitment rule`);
			assert.ok(!tool.description.includes("near-miss"), `${name} drops the doctrine (now in the shared prompt)`);
		}
	});
	it("the craft now lives in the shared prompt chunk (both agents compose it)", async () => {
		const shared = await fs.promises.readFile(
			path.join(PATHS.root, "src/agent/prompts/shared/20-question-tools.md"),
			"utf-8",
		);
		assert.ok(shared.includes("asymmetry"), "the option craft moved here, not deleted");
		assert.ok(shared.includes("TRANSCRIBED SPEECH"), "the dictation-leniency note lives here");
	});
});

/**
 * THE PRACTICE AGENT (practice sessions, owner design 2026-10-04): the
 * tool gating law (an agent cannot pose while a problem is active, cannot
 * conclude with nothing active), the registry shape (problem + conclude
 * ONLY — no question, plan, or job tools), and the prompt composition
 * (practice composes its own directory alone — no teaching base, no
 * shared fragments).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import {
	activeProblemOf,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import { concludeInputObject, concludeTool, createPracticeGate, problemTool, practiceTools } from "../src/agent/tools/practice.ts";
import { composeInstructions, createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { allSegmentPaths } from "../src/agent/prompt-segments.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

/** A record whose latest problem call is ACTIVE (pose + ack, nothing after). */
function activeProblemRecord(): LhMessage[] {
	const pose: LhMessage & AssistantMessage = {
		id: "msg_a1",
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Show…" } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: "msg_r1",
		role: "toolResult",
		toolCallId: "call_p1",
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here…" }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [pose, ack];
}

function recordStore(messages: LhMessage[]) {
	return {
		store: {
			getChat: (_id: string) => ({ messages, kind: "practice" }),
		},
	};
}

const ctxOf = (messages: LhMessage[]) => ({ chatId: "c1", chatStore: recordStore(messages).store });
const PROBLEM_INPUT = {
	statement: "Prove the sum is even.",
	mode: "recall",
	target: ["parity-sum"],
	modelSolution: "Pair them; each pair is even.",
} as const;

const CONCLUDE_INPUT = {
	outcome: "solved",
	verdict: "Clean — the pairing came unaided.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

// ── the gating law ───────────────────────────────────────────────────────────

describe("the practice tool gating law", () => {
	it("problem acks on a quiet record and ends the turn (terminate)", async () => {
		const result = await problemTool(createPracticeGate(ctxOf([]))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.match((result.content[0] as { text: string }).text, /Problem posed/);
	});

	it("problem is REJECTED while a problem is active (conclude first)", async () => {
		const result = await problemTool(createPracticeGate(ctxOf(activeProblemRecord()))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"a problem is already active — call conclude on it before posing the next one",
		]);
	});

	it("conclude is REJECTED with nothing active", async () => {
		const result = await concludeTool(createPracticeGate(ctxOf([]))).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"no active problem to conclude — pose one first",
		]);
	});

	it("conclude acks on the active problem and the turn CONTINUES (no terminate)", async () => {
		const result = await concludeTool(createPracticeGate(ctxOf(activeProblemRecord()))).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, undefined);
	});

	it("THE BKT INCIDENT — a mid-turn conclude → pose pair works (the gate is turn-scoped, not record-frozen)", async () => {
		// One turn, one toolset: the record froze at the write-ahead with
		// the old problem active. The gates used to re-read that frozen
		// record per execute, so the pose after a successful conclude
		// always died on "a problem is already active" until the model
		// gave up ("the problem slot is stuck").
		const gate = createPracticeGate(ctxOf(activeProblemRecord()));
		const tools = { problem: problemTool(gate), conclude: concludeTool(gate) };
		const conclude = await tools.conclude.execute("call_c1", CONCLUDE_INPUT as never);
		assert.equal(conclude.isError, undefined, "the conclude acks against the seeded record");
		const pose = await tools.problem.execute("call_p2", PROBLEM_INPUT as never);
		assert.equal(pose.isError, undefined, "the freed gate lets the next problem through — SAME turn");
		const greedy = await tools.problem.execute("call_p3", PROBLEM_INPUT as never);
		assert.equal(greedy.isError, true, "the gate re-arms on the successful pose");
	});
});

// ── target validation (the mastery-trace contract, owner round 9) ──────────

describe("target validation — names normalize to ids, unknowns reject", () => {
	const NODES = [
		{ id: "n_parity", name: "Parity of a sum", statement: "The sum of two odds is even." },
		{ id: "n_pairing", name: "Pairing", statement: "Pair elements to count parity." },
	] as const;
	const graphNodes = () => NODES;

	it("a NAME target silently normalizes to the canonical id (the record carries ids)", async () => {
		const healed = problemTool(createPracticeGate(ctxOf([])), graphNodes).prepareArguments!({
			...PROBLEM_INPUT,
			target: ["Parity of a sum", "pairing"],
		}) as { target: string[] };
		assert.deepEqual(healed.target, ["n_parity", "n_pairing"], "case-insensitive name → id, whole-graph set");
	});

	it("an id target passes through untouched (already canonical)", async () => {
		const healed = problemTool(createPracticeGate(ctxOf([])), graphNodes).prepareArguments!({
			...PROBLEM_INPUT,
			target: ["n_parity"],
		}) as { target: string[] };
		assert.deepEqual(healed.target, ["n_parity"]);
	});

	it("an UNKNOWN target rejects with a one-line error and does NOT arm the gate", async () => {
		const gate = createPracticeGate(ctxOf([]));
		const tool = problemTool(gate, graphNodes);
		const rejected = await tool.execute("call_x", { ...PROBLEM_INPUT, target: ["ghost-prop"] } as never);
		assert.equal(rejected.isError, true);
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /ghost-prop/);
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /proposition ids from the session context/);
		// the message teaches the exit (round 12): omitting always works
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /omit target entirely/);
		// honest activation (the BKT law): a rejected pose frees the slot —
		// the next, valid pose goes through.
		const valid = await tool.execute("call_y", { ...PROBLEM_INPUT, target: ["n_parity"] } as never);
		assert.equal(valid.isError, undefined);
	});

	it("UNTAGGED PROBLEMS (owner round 12): absent target poses freely; [] heals away to absent", async () => {
		const tool = problemTool(createPracticeGate(ctxOf([])), graphNodes);
		const absent = await tool.execute("call_a", { statement: "S", mode: "recall", modelSolution: "M" } as never);
		assert.equal(absent.isError, undefined, "no targets = an untagged problem, never a rejection");
		const healed = tool.prepareArguments!({ statement: "S", mode: "recall", target: [], modelSolution: "M" }) as {
			target?: string[];
		};
		assert.ok(!healed.target || healed.target.length === 0, "an explicit [] is the model saying no-targets — healed away");
	});

	it("NO node source (the legacy/test wiring) = no validation, free strings ack", async () => {
		const result = await problemTool(createPracticeGate(ctxOf([]))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, undefined);
	});
});

// ── the registry + the agent ────────────────────────────────────────────────

describe("the practice agent", () => {
	it("bare registry: the session pair + the learner-filesystem set — no question, plan, or lesson tools", () => {
		const tools = practiceTools(ctxOf([]));
		assert.deepEqual(
			Object.keys(tools).sort(),
			["conclude", "find", "grep", "ls", "problem", "read"],
		);
	});

	it("THE RARELY-NEEDED SET (owner round 10): jobs + map readers compose in when their roots are passed", () => {
		const jobs = { chatId: "c1", jobStore: null as never, spawn: (() => {}) as never, searchAvailable: () => false };
		const graph = { chatStore: null as never, graphStore: null as never };
		const tools = practiceTools({ ...ctxOf([]), jobs, graph });
		// Both jobs remain available keylessly; the prober's two map
		// readers stay behind their existing settings gate. Practice does
		// not apply the teacher/prober user tool-toggle filter.
		assert.deepEqual(
			Object.keys(tools).sort(),
			["conclude", "find", "grep", "list_propositions", "list_sessions", "ls", "pdf", "problem", "read", "research"],
		);
		const withSearch = practiceTools({ ...ctxOf([]), jobs: { ...jobs, searchAvailable: () => true }, graph });
		assert.ok(withSearch.research, "a live engine also keeps research");
	});

	it("constructs with exactly the two practice tools", () => {
		// baseAgentOptions needs an engine (the BYOK thrower is the only
		// fallback) — inject a never-streamed faux engine for the smoke.
		const agent = createPracticeAgent(ctxOf([]), {
			engine: {
				model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never,
				streamFn: (async () => {
					throw new Error("not streamed in this test");
				}) as never,
			},
		});
		// The agent built with the live turn API (the registry itself is
		// pinned above; pi's Agent exposes no state getter).
		assert.equal(typeof agent.prompt, "function");
		assert.equal(typeof agent.steer, "function");
		assert.equal(typeof agent.waitForIdle, "function");
	});
});

// ── persistent nudges (shipped defaults, no model calls) ──────────────────────

describe("persistent practice nudges", () => {
	const doctrine = readFileSync(new URL("../src/agent/prompts/practice/10-doctrine.md", import.meta.url), "utf8");
	const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
	const approvedParagraphs = [
		"- When a nudge does not land, reassess where the learner is stuck and offer only the next necessary piece of information. Do not jump to the full solution. Tentative answers, questions, and thinking aloud remain work in progress.",
		"**On a wrong answer**, state the verdict plainly and localize the first break without giving the correction. Give the smallest nudge that lets the learner make the next move, then wait. If that nudge does not land, give another minimal nudge based on the new thinking. A failed attempt is never a reason to reveal the correction or conclude the problem. Continue until the learner finds and completes the correct solution.",
		"Conclude when the learner has solved the problem correctly or explicitly asks to end it. Do not infer permission to end it from mistakes, elapsed time, the number of attempts, frustration, or an apparent inability to proceed.",
	];

	it("preserves the approved paragraphs in source and the effective default prompt", () => {
		// Pin approved wording and Markdown, but allow incidental line wrapping.
		for (const text of [doctrine, composeInstructions("practice")]) {
			const paragraphs = text.split(/\n\s*\n|\n(?=- )/).map(normalizeWhitespace);
			for (const approved of approvedParagraphs) {
				assert.ok(paragraphs.includes(approved), `missing approved paragraph: ${approved}`);
			}
		}
	});

	it("does not compose the retired attempt cutoff, failed-repair reveal, or automatic-abort instructions", () => {
		for (const text of [doctrine, composeInstructions("practice")]) {
			const normalized = normalizeWhitespace(text);
			assert.doesNotMatch(normalized, /\b(?:one|single|1) bounded attempt\b/i);
			assert.doesNotMatch(normalized, /If the repair attempt fails, reveal and move on/i);
			assert.doesNotMatch(normalized, /A correction found by the learner after a confident error consolidates more/i);
			assert.doesNotMatch(normalized, /when the trace shows genuine inability, drop straight to R5 and reveal/i);
			assert.doesNotMatch(normalized, /when the learner surrenders or cannot proceed/i);
			assert.doesNotMatch(normalized, /when the marginal yield of staying is exhausted/i);
			assert.doesNotMatch(normalized, /do not withhold them past the point of exhaustion/i);
		}
	});

	it("preserves the approved concluded-problem switch and unbounded structural repair in source and the effective default prompt", () => {
		const approvedDifficulty = "3. **Difficulty** — from the last outcomes on this target: clean success, one notch up; success that needed hints, hold; a miss, one notch down and consider dropping a mode. Two missed concluded problems in a row on this target: switch targets for the next demand. Never switch away from an active problem because of the number of attempts.";
		const approvedClassification = "Classify every miss: cue miss (nothing came), discrimination error (wrong candidate won), execution slip (right proposition, wrong run), careless, or structural (the retrieved proposition is itself wrong — a misconception). The first four are practice information. Structural misses call for minimal nudges toward repairing the misconception, not an immediate correction or re-teaching. Keep each nudge surgical; do not impose a one-line or one-attempt limit on the repair as a whole.";
		for (const text of [doctrine, composeInstructions("practice")]) {
			const normalized = normalizeWhitespace(text);
			assert.ok(normalized.includes(approvedDifficulty), "preserve the difficulty readout and exact approved switching rule");
			assert.ok(normalized.includes(approvedClassification), "preserve the miss taxonomy and exact approved structural-repair rule");
			assert.doesNotMatch(normalized, /two misses in a row, switch targets/i);
			assert.doesNotMatch(normalized, /Structural gets one surgical line/i);
			assert.doesNotMatch(normalized, /the correction, stated once/i);
			assert.doesNotMatch(normalized, /if a repair needs more than a line/i);
		}
	});

	it("preserves the approved misconception introduction without an affirmative one-line repair cap", () => {
		const approvedIntroduction = "- **Not a teaching session.** You will find misconceptions. Address them with minimal, surgical nudges, over as many exchanges as needed. A practice session that drifts into re-teaching has stopped practicing.";
		for (const text of [doctrine, composeInstructions("practice")]) {
			const normalized = normalizeWhitespace(text);
			assert.ok(normalized.includes(approvedIntroduction), "preserve the exact approved introduction and the rest of the not-teaching bullet");
			assert.doesNotMatch(normalized, /Repair them in a line, surgically, and return to practice\./i);
		}
	});

	it("keeps the many-claims default, hint ladder, dismissal, and explicit-go-ahead pause", () => {
		const prompt = normalizeWhitespace(composeInstructions("practice"));
		assert.match(prompt, /A problem may take many claims; staying is the default/);
		for (const rung of ["R0", "R1", "R2", "R3", "R4", "R5"]) {
			assert.ok(prompt.includes(`**${rung} —`));
		}
		assert.match(prompt, /Concluding ends your turn; the next problem is posed only when the learner explicitly moves on/);
		assert.match(prompt, /After the conclude's result.*END YOUR TURN: no further tool calls in that reply, never another problem/);
		assert.match(prompt, /A clarification question is never the go-ahead; when in doubt, answer and wait/);
		assert.match(prompt, /The learner may discard a problem without concluding it/);
	});

	it("aligns the conclude description with the canonical ack without changing outcomes or the runtime pause mechanism", async () => {
		const tool = concludeTool(createPracticeGate(ctxOf(activeProblemRecord())));
		const description = normalizeWhitespace(tool.description);
		assert.match(description, /records the outcome \+ verdict, reveals the committed solution, and frees the learner's composer/);
		assert.match(description, /After the result, say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls/);
		assert.ok(description.includes(CONCLUDE_ACK_TEXT.slice(CONCLUDE_ACK_TEXT.indexOf("The next problem"))));
		assert.match(description, /Nothing may conclude unless a problem is active/);
		assert.doesNotMatch(description, /turn CONTINUES|reveal, then pose the next problem/);
		assert.deepEqual(concludeInputObject.properties.outcome.anyOf.map((outcome) => outcome.const), [
			"solved", "solvedWithHints", "movedOn", "surrendered", "dismissed",
		]);
		const result = await tool.execute("call_persistent_nudges", CONCLUDE_INPUT as never);
		assert.equal((result.content[0] as { text: string }).text, CONCLUDE_ACK_TEXT);
		assert.equal(result.terminate, undefined, "closing prose stays possible; the pause remains an instruction, not a new runtime gate");
	});
});

// ── the prompt composition ──────────────────────────────────────────────────

describe("practice prompt composition (own directory + the formatting appendix)", () => {
	it("composes base + doctrine — never the teaching base or question/confidence mechanics", () => {
		const prompt = composeInstructions("practice");
		// The base's voice section and the doctrine's spine are present…
		assert.match(prompt, /Everything in this section deletes a default/);
		assert.match(prompt, /You run practice sessions\./);
		assert.match(prompt, /## Standing prohibitions/);
		// …and nothing from the teaching system prompt or shared fragments.
		assert.doesNotMatch(prompt, /install understanding/);
		// The shared 20-question-tools doctrine (predict/check) must not
		// compose — practice has its own demand theory.
		assert.doesNotMatch(prompt, /predict/i);
	});

	it("the SHARED voice + accuracy compose (owner round 13): ONE law across every agent, and the stale line is dead", () => {
		const prompt = composeInstructions("practice");
		// accuracy (prompt-refinement round, 2026-10-07): the felt-doubt bar —
		// one law across every agent; the old round-10 pointer lived in the
		// accuracy chunk, the mechanics now live in each agent's own sections
		assert.match(prompt, /one confidently-delivered hallucination poisons that/);
		assert.match(prompt, /The bar is the doubt itself/);
		// practice's own fact-check law (the rarely-needed framing is dead)
		assert.match(prompt, /grades the learner against a lie/);
		assert.ok(!prompt.includes("exceptions, not habits"), "the rarely-needed framing is gone");
		assert.ok(!prompt.includes("no research tool here"), "the stale line is gone");
		// the thinking-fields doctrine composes into practice too (one law)
		assert.match(prompt, /primary data/);
		// the teacher composes the same shared chunks (one law)
		const teacher = composeInstructions("teacher");
		assert.match(teacher, /one confidently-delivered hallucination poisons that/);
		assert.match(teacher, /Everything in this section deletes a default/);
		assert.match(teacher, /The bar is the doubt itself/);
		assert.match(teacher, /primary data/);
		// the no-double-plan rule (owner-reported: plan drawn twice)
		assert.match(teacher, /Never draw the plan again in your prose/);
		// plan rewriting is normal, not exceptional (continuous adaptation)
		assert.match(teacher, /Rewriting is a normal, common event/);
		// planning is the natural verification moment
		assert.match(teacher, /planning is the natural moment for verification/);
		// no size ceilings, and the detour keeps the pace (owner round, 2026-10-07)
		assert.ok(!teacher.includes("Typically 5–15 nodes"), "the node-count cap is dead");
		assert.match(teacher, /No size ceiling/);
		assert.match(teacher, /never rush the repair/);
		assert.match(teacher, /one and only pace/);
		assert.match(teacher, /nothing to rush/, "the goal reiteration composes");
	});

	it("the prober doctrine steers difficulty by evidence (owner round, 2026-10-07)", () => {
		const prober = composeInstructions("prober");
		assert.match(prober, /Enter near the top, not the bottom/);
		assert.match(prober, /Strands inform each other/);
		assert.match(prober, /never descending into already-bracketed territory/);
		// the confidence + thinking signals are wired into question selection
		assert.match(prober, /the verdict, his confidence, and his thinking field together set where the next question should sit/);
	});

	it("the SHARED formatting guide composes (owner, 2026-10-04 late): LaTeX delimiters in every setting", () => {
		const prompt = composeInstructions("practice");
		// The standard delimiter law is shared by all three authoring agents.
		for (const agent of ["practice", "prober", "teacher"] as const) {
			const instructions = composeInstructions(agent);
			assert.ok(instructions.includes("Inline `$f(x)$`, display `$$` fenced on its own lines."));
			assert.ok(!instructions.includes("NEVER `$` or `$$`"));
		}
		assert.ok(prompt.indexOf("# The practice session") < prompt.indexOf("## Formatting"), "formatting rides as the appendix");
	});

	it("base precedes doctrine (00- sorts before 10-)", () => {
		const prompt = composeInstructions("practice");
		assert.ok(prompt.indexOf("The agent") < prompt.indexOf("# The practice session"));
	});

	it("the segment registry knows practice (override paths resolve)", () => {
		assert.ok(allSegmentPaths().includes("practice/00-base.md"));
		assert.ok(allSegmentPaths().includes("practice/10-doctrine.md"));
	});
});

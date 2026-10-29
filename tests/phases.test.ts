/**
 * phases — the event-driven phase chain (docs/probe-teach-split.md §4).
 *
 * probe ends at the first CONCLUDED probe_done (output-available); teaching
 * begins at the FIRST nodeId-tagged quiz CALL (the inferred seam, owner
 * ruling 2026-09-26 — the verdict death: presenting the plan ends the
 * teacher's turn, the learner's reply is natural text, and nothing flips
 * the phase until a question ABOUT a plan node is actually posed). No
 * stored-tree seam: the phase is a pure fold over the transcript, so it can
 * never stick (the old currentNodeId-based phaseOfTree read a field nothing
 * ever set).
 */
import assert from "node:assert";
import test from "node:test";
import type { LhViewMessage } from "../src/core/view.ts";
import { phaseAt3, phaseTimeline, type Phase3 } from "../src/core/phases.ts";

/** Text-only user message. */
function user(text: string): LhViewMessage {
	return { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** An assistant message carrying a tool part in the given state. */
function assistantTool(
	name: string,
	state: "input-available" | "output-available" | "output-error",
	output?: unknown,
): LhViewMessage {
	return {
		id: `a_${name}_${state}_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: `tool-${name}`, state, ...(output !== undefined ? { output } : {}) } as never],
	};
}

/** A quiz call with its parsed input — `nodeId` present iff tagged. */
function assistantQuiz(input: Record<string, unknown> | undefined): LhViewMessage {
	return {
		id: `a_quiz_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: "tool-quiz", ...(input !== undefined ? { input } : {}) } as never],
	};
}

const DONE_ASSESSMENT = { assessment: { strands: [{ strand: "s", assessment: "a" }] } };
const PLAN_OK = { ok: true, tree: { nodes: [{ id: "n1", title: "N" }], edges: [] } };

test("phaseAt3: probe until a concluded probe_done; plan until the first nodeId-tagged quiz; teach after", () => {
	const probe = phaseAt3([user("teach me calculus"), assistantQuiz({ question: "q", correctAnswer: "a" })]);
	assert.equal(probe, "probe", "an UNTAGGED quiz alone never ends the probe (probe quizzes carry no nodeId)");

	const concluded = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
	]);
	assert.equal(concluded, "plan", "a concluded probe_done ends the probe (planning begins)");

	const presented = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("looks good, go"),
	]);
	assert.equal(presented, "plan", "plan_init + the learner's go-ahead TEXT present and sanction nothing");

	const teaching = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("looks good, go"),
		assistantQuiz({ question: "q", nodeId: "gravity-basics", correctAnswer: "a" }),
	]);
	assert.equal(teaching, "teach", "the first nodeId-tagged quiz CALL is where teaching begins");

	const failedPlan = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-error", { ok: false, error: "bad mermaid" }),
		assistantQuiz({ question: "q", nodeId: "n1", correctAnswer: "a" }),
	]);
	assert.equal(failedPlan, "teach", "a tagged quiz begins teaching even after a failed init attempt");
});

test("phaseAt3: the tag is the seam — natural text and untagged questions never start teaching", () => {
	const plainText = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("The plan is accepted — begin teaching."), // words alone
		assistantQuiz({ question: "ad-hoc check", correctAnswer: "a" }), // untagged
	]);
	assert.equal(plainText, "plan", "only a nodeId-tagged quiz flips the seam — text and ad-hoc checks never do");

	const taggedOutOfOrder = phaseAt3([
		user("teach me"),
		assistantQuiz({ question: "q", nodeId: "n1", correctAnswer: "a" }), // before probe_done
	]);
	assert.equal(taggedOutOfOrder, "probe", "the chain never skips");
});

test("phaseAt3: a mere probe_done CALL (input-available, not yet concluded) keeps the probe open", () => {
	const still = phaseAt3([user("teach me"), assistantTool("probe_done", "input-available")]);
	assert.equal(still, "probe");
});

test("phaseAt3 and phaseTimeline: explicit probe refusals never advance the UI phase", () => {
	const refused = assistantTool("probe_done", "output-available", { ok: false, error: "question open" });
	const errored = assistantTool("probe_done", "output-error", { ok: true });
	const tagged = assistantQuiz({ nodeId: "n1" });
	const clean = assistantTool("probe_done", "output-available", { ok: true });
	const messages = [refused, errored, tagged, clean, tagged];
	assert.equal(phaseAt3(messages, 2), "probe");
	assert.deepEqual(phaseTimeline(messages), ["probe", "probe", "probe", "plan", "teach"]);
});

test("phaseAt3: legacy transcripts without probe_done read as probe (no backwards compat — data wiped)", () => {
	const legacy = phaseAt3([user("teach me lacan"), assistantTool("plan_init", "output-available", PLAN_OK)]);
	assert.equal(legacy, "probe", "plan_init alone never flips a phase post-split");
});

test("phaseTimeline: folds messages into phase spans for the dividers", () => {
	const timeline = phaseTimeline([
		user("teach me"),
		assistantTool("quiz", "output-available"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantTool("plan_init", "output-available", PLAN_OK),
		user("what does node 1 mean?"), // side question — still planning
		user("go on"),
		assistantQuiz({ question: "q", nodeId: "n1", correctAnswer: "a" }),
		assistantQuiz({ question: "q2", nodeId: "n2", correctAnswer: "a" }),
	]);
	assert.deepEqual(timeline satisfies Phase3[], ["probe", "probe", "plan", "plan", "plan", "plan", "teach", "teach"]);
	assert.equal(timeline.length, 8);
});

test("phaseAt3: empty transcript is probe", () => {
	assert.equal(phaseAt3([]), "probe");
});

// ─── the native fold (phaseAt3Lh over LhMessage[]) ──────────────────────────

import type { LhMessage } from "../src/core/native-messages.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";

/** A native toolResult (the probe_done conclusion). */
function toolResult(toolName: string, isError = false): LhMessage {
	return {
		id: `tr_${toolName}_${Math.random().toString(36).slice(2, 6)}`,
		role: "toolResult",
		toolCallId: `call_${toolName}`,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: Date.now(),
	} as LhMessage;
}

/** A native assistant message carrying a quiz toolCall — arguments carry
 *  `nodeId` iff tagged (exactly what the wire would persist). */
function assistantQuizCall(arguments_: Record<string, unknown>): LhMessage {
	return {
		id: `a_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		content: [{ type: "toolCall", id: "call_quiz", name: "quiz", arguments: arguments_ }],
		stopReason: "toolUse",
		usage: undefined,
		timestamp: Date.now(),
	} as unknown as LhMessage;
}

function assistantProbeCall(): LhMessage {
	return {
		...assistantQuizCall({}),
		content: [{ type: "toolCall", id: "call_probe_done", name: "probe_done", arguments: {} }],
	} as LhMessage;
}

test("phaseAt3Lh (native fold): probe→plan at the clean probe_done result; plan→teach at the first tagged quiz CALL", () => {
	const done = toolResult("probe_done");
	const call = assistantProbeCall();
	const tagged = assistantQuizCall({ question: "q", nodeId: "gravity-basics", correctAnswer: "a" });
	const untagged = assistantQuizCall({ question: "q", correctAnswer: "a" });

	assert.equal(phaseAt3Lh([call, done, untagged]), "plan", "an untagged quiz call never starts teaching");
	assert.equal(phaseAt3Lh([call, done, tagged]), "teach", "the tagged quiz CALL is the seam");
	assert.equal(phaseAt3Lh([tagged]), "probe", "the chain never skips (tag before probe_done)");
	assert.equal(
		phaseAt3Lh([call, toolResult("probe_done", true), tagged]),
		"probe",
		"an ERRORED probe_done concludes nothing",
	);
	// The two folds agree on the same settled transcript (the view projection
	// of the tagged call carries its arguments as the part input).
	assert.equal(
		phaseAt3Lh([call, done, tagged]),
		phaseAt3([
			{ parts: [{ type: "tool-probe_done", state: "output-available" } as never] },
			{ parts: [{ type: "tool-quiz", input: { nodeId: "gravity-basics" } } as never] },
		]),
	);
});

// ─── the explain mechanic at the seam (owner 2026-09-27) ───────────────────
// Both quizzing tools (quiz OR explain, whichever the settings armed) open
// teaching — the seam is structural, not name-bound to the MC tool.

test("phaseAt3 + phaseAt3Lh: a tagged explain CALL is the plan→teach seam too", () => {
	const done = toolResult("probe_done");
	const call = assistantProbeCall();
	const explainCall = (args: Record<string, unknown>): LhMessage =>
		({
			id: "a_explain",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_explain", name: "explain", arguments: args }],
			timestamp: Date.now(),
		}) as unknown as LhMessage;

	const tagged = explainCall({ question: "q", correctAnswer: "a", explanation: "e", nodeId: "gravity-basics" });
	const untagged = explainCall({ question: "q", correctAnswer: "a", explanation: "e" });

	assert.equal(phaseAt3Lh([call, done, untagged]), "plan", "an untagged explain never starts teaching");
	assert.equal(phaseAt3Lh([call, done, tagged]), "teach", "the tagged explain CALL is the seam");
	assert.equal(
		phaseAt3Lh([call, done, tagged]),
		phaseAt3([
			{ parts: [{ type: "tool-probe_done", state: "output-available" } as never] },
			{ parts: [{ type: "tool-explain", input: { nodeId: "gravity-basics" } } as never] },
		]),
		"the two folds agree on the explain mechanic",
	);
});

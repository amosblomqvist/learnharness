import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult, serverExecute } from "./tool-execute.ts";
import {
	askInputSchema,
	askOptionProblems,
	explainInputBase,
	explainInputObject,
	explainInputProblems,
	parseOptionsIfString,
	probeQuizInputSchema,
	quizInputObject,
	quizInputProblems,
} from "../core/question-core.ts";
import { filterEnabledTools, type EnabledTools } from "../core/pending.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type PdfInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";
import { probeDoneTool, type ProbeDoneContext } from "./tools/probe.ts";
import { proberGraphTools } from "./tools/graph.ts";
import { readTool } from "./tools/read.ts";
import { lsTool } from "./tools/ls.ts";
import { findTool } from "./tools/find.ts";
import { grepTool } from "./tools/grep.ts";
import { healToolRecord } from "./tools/heal.ts";
import type { GraphStore } from "../core/ports.ts";

export { jobTools };
export type { ProbeDoneContext } from "./tools/probe.ts";

/**
 * The agent-split tool composition (docs/probe-teach-split.md §1): the
 * PROBER and the TEACHER are different agents with different tool sets.
 * The question tools share a NAME but are genuinely DIFFERENT tools —
 * the prober's quiz has NO nodeId field at all (its declaration is built
 * from quizInputBase; the model's schema never mentions nodeId), the
 * teacher's carries the validated position field.
 *
 * - Question tools (quiz / ask_user_question): CLIENT-ANSWERED. Their
 *   execute validates the authoring refinements (the cross-field rules no
 *   schema carries — quizInputProblems / askOptionProblems; a failure
 *   throws ToolInputError, which pi's loop converts to an error tool
 *   result the model retries on), then returns the synthetic
 *   "question posed" placeholder (questionResult: terminate: true — the
 *   turn ends; the call streams to the browser in `input-available`
 *   state; the learner answers in the dock; the client grades and sends
 *   the verdict with addToolOutput). Input schemas live in
 *   core/question-core. Question tools opt into SEQUENTIAL execution so
 *   parallel calls resolve in the model's call order (the dock's subject
 *   can never flip mid-turn).
 * - probe_done (src/agent/tools/probe.ts): SERVER-SIDE seam tool.
 * - planTools (src/agent/tools/plan.ts): SERVER-SIDE — author-once
 *   plan_init. Teacher only.
 * - jobTools (src/agent/tools/jobs.ts): SERVER-EXECUTED dispatch. Teacher
 *   only.
 */

/** GLM wobble guard (owner-approved, 2026-09-26): models sometimes emit
 *  `options` as a JSON-encoded string instead of an array; pi runs this
 *  BEFORE schema validation, so a double-encoded call lands instead of
 *  bouncing back as a validation error + wasted retry turn. NOTE: pi
 *  persists the tool call with its RAW arguments — the client coerces
 *  again in normalizeOptions (question-core), the same parseOptionsIfString.
 *  Anything unparseable passes through untouched: validation then reports
 *  honestly and the agent retries with a real error to learn from. */
function prepareQuestionArguments<T extends object>(args: unknown): T {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const o = args as { options?: unknown };
		if (typeof o.options === "string") {
			const parsed = parseOptionsIfString(o.options);
			if (parsed !== o.options) return { ...o, options: parsed } as T;
		}
		return o as T;
	}
	return args as T;
}

export const askUserQuestionTool: AgentTool<typeof askInputSchema> = {
	name: "ask_user_question",
	label: "ask_user_question",
	description:
		"Ask the learner a single question and pause until they answer. NOT graded — there is no correct answer. " +
		"Use when requirements are ambiguous, preferences are needed, a decision would materially affect the lesson, " +
		"or you need an open-ended response. ONE question per turn: call a single ask_user_question, then end your " +
		"turn — his answer determines the next.",
	parameters: askInputSchema,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = askOptionProblems(input.options ?? []);
		if (problems.length > 0) return invalidInputResult("ask_user_question", problems);
		return questionResult();
	},
};

// ─── the question tools ───────────────────────────────────────────────────────
//
// MECHANICAL DESCRIPTIONS ONLY (owner 2026-10-03): a tool's description
// carries what the tool DOES and how its fields work — nothing about what
// the questions should BE. The craft (option-building, free-recall
// grading, question roles) lives in the system prompt — a single-sourced
// chunk both agents compose (prompts/shared/20-question-tools.md and the
// teacher's question fragments), reversing the 2026-09-27 placement now
// that the question family has grown (predict/check roles, future
// quiz variants): duplicates stay honest by sharing SCHEMA ATOMS
// (question-core) + PROMPT CHUNKS, and each tool declares only its
// mechanical delta.
//
// ONE sanctioned exception (owner, 2026-10-12): each quiz tool's
// description ends with a COMPLETE example call — compact, phase-correct
// (probe carries no phase metadata; quiz leads with type+nodeId), doubling
// as the JSON-escaping exemplar (LaTeX backslashes double inside JSON
// strings). Placement ruling: WITH THE TOOL, beside its exact schema — a
// shared-prompt example is phase-ambiguous (the models fumbled exactly
// these metadata fields), per-agent prompt copies would drift. Serialized
// from ONE canonical body so the variants cannot disagree; craft doctrine
// stays in the prompts.

/** The canonical example body (owner-approved content, 2026-10-12): a
 *  compact applied question whose fields exercise the escaping hazards —
 *  braced commands (\frac, \cos), inline and display math, newlines —
 *  while doubling as an exemplar of good craft: uniform options, stable
 *  values, reasoning (explanation) committed before correctAnswer.
 *  JSON.stringify renders the wire text, so the escaping the model sees
 *  is by construction the correct one. Exported for the description pins. */
export const quizExampleBody = {
	question: "A signal is $y=\\sin(2x)$ and $\\frac{dx}{dt}=3$. What is $\\frac{dy}{dt}$?",
	options: [
		{ label: "$6\\cos(2x)$", value: "a" },
		{ label: "$2\\cos(2x)$", value: "b" },
		{ label: "$3\\cos(2x)$", value: "c" },
	],
	explanation:
		"The phase changes twice as fast as $x$; multiply by the sine's slope:\n$$\n\\frac{dy}{dt}=\\cos(2x)\\cdot2\\cdot3=6\\cos(2x)\n$$",
	correctAnswer: "a",
};

/** The quiz mechanics every variant shares; `delta` appends the variant's
 *  own fields (its NAME among them — the probe-phase tools self-reference
 *  as probe/recall, owner 2026-10-09). All mechanics, zero doctrine — plus
 *  the one sanctioned example (above). */
function quizDescription(delta: { name: "quiz" | "probe"; nodeId: boolean; types: boolean }): string {
	const base =
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Unlike ask_user_question (which collects preferences/decisions with no right answer), " +
		delta.name +
		" always has a " +
		"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
		"can show an explanation. Options-only: single-select or multi-select, plus an automatic 'I don't know' " +
		"choice so the learner can signal a genuine gap instead of guessing. An always-present optional thinking " +
		"field lets the learner attach his reasoning to ANY answer; it reaches you only when non-empty. " +
		"No free-text answers — for non-graded questions use ask_user_question instead. " +
		(delta.types
			? "Every call declares `type` — the question's role in the teaching cycle; the field's own description says when each kind fires. "
			: "") +
		(delta.nodeId
			? "Set `nodeId` (required) to the plan node this question is about — validated at call time against the session's plan map. For off-map checks use ask_user_question. "
			: "") +
		"ONE question per turn: call a single " +
		delta.name +
		", then end your turn — his answer determines the next.";
	// Phase-correct shape: the teach example LEADS with the required pair
	// (type, nodeId — the 2026-10-09 drop-order ruling); the probe example
	// carries no phase metadata at all, exactly like the probe schema.
	const example = delta.nodeId ? { type: "check" as const, nodeId: "chain-rule", ...quizExampleBody } : quizExampleBody;
	return (
		base +
		"\nExample arguments — copy the escaping exactly: inside JSON strings a LaTeX backslash is \\\\ and a newline is \\n.\n```json\n" +
		JSON.stringify(example, null, 2) +
		"\n```" +
		(delta.nodeId ? " The example's nodeId is illustrative — copy an exact id from this session's plan_init." : "")
	);
}

/** The explain mechanics (free-recall quizzing): the commitment rule is
 *  the GRADING CONTRACT — mechanics, not doctrine. The softer doctrine
 *  (near-miss reading, genuine gaps) lives in the shared prompt chunk.
 *  `name`: the teach tool self-references as explain, the probe variant
 *  as recall (owner 2026-10-09). */
function explainDescription(name: "explain" | "recall", nodeId: boolean): string {
	return (
		"Ask the learner to EXPLAIN something in his own words — a graded check with NO options: he types a free-text " +
		"answer. Unlike ask_user_question (no right answer), " +
		name +
		" always has one. THE COMMITMENT RULE: " +
		"correctAnswer is the FULL correct answer in your own words, reasoning included, COMMITTED before he ever " +
		"sees the question. When his answer returns, grade it strictly against the commitment — never revise it " +
		"after seeing his words. He sees the committed answer on submit. " +
		(nodeId
			? "Set `nodeId` (required) to the plan node this question is about — validated at call time against the session's plan map. "
			: "") +
		"ONE question per turn: call a single " + name + ", then end your turn — his answer determines the next."
	);
}

/** The prober's multiple-choice quizzing tool — named `probe`, not
 *  `quiz` (owner, 2026-10-09): the probe and teach schemas differ
 *  (neither `type` nor `nodeId` exists while probing), and a shared name
 *  invited the model to carry its probe-phase call shape into teaching
 *  — the first teach quiz after plan_init dropped `nodeId` on exactly
 *  that habit (the tools_fails_2 incident). Distinct names make the
 *  phase boundary visible in the transcript itself: history written by
 *  `probe` never lies about what `quiz` requires. */
export const probeQuizTool: AgentTool<typeof probeQuizInputSchema> = {
	name: "probe",
	label: "probe",
	description: quizDescription({ name: "probe", nodeId: false, types: false }),
	parameters: probeQuizInputSchema,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = quizInputProblems(input);
		if (problems.length > 0) return invalidInputResult("probe", problems);
		return questionResult();
	},
};

/** The teacher's free-recall variant (nodeId-validated, same seam as the
 *  teach quiz — phases/plan recognize BOTH tool names). */
export function teachExplainToolFor(
	ctx: Pick<PlanToolContext, "chatId" | "chatStore">,
): AgentTool<typeof explainInputObject> {
	return {
		name: "explain",
		label: "explain",
		description: explainDescription("explain", true),
		parameters: explainInputObject,
		prepareArguments: prepareQuestionArguments,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...explainInputProblems(input)];
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("explain", problems);
			return questionResult();
		},
	};
}

/** The prober's free-recall variant (no nodeId — same pattern as the
 *  probe quiz). */
/** The prober's free-recall variant — named `recall`, not `explain`
 *  (owner, 2026-10-09), for the same phase-boundary reason as `probe`:
 *  the teach explain adds `type` and `nodeId`; a shared name carried the
 *  probe call shape into teaching. Old probe-phase records keep the
 *  `explain` name and parse identically (the display seam accepts
 *  both). */
export const probeExplainTool: AgentTool<typeof explainInputBase> = {
	name: "recall",
	label: "recall",
	description: explainDescription("recall", false),
	parameters: explainInputBase,
	prepareArguments: prepareQuestionArguments,
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = explainInputProblems(input);
		if (problems.length > 0) return invalidInputResult("recall", problems);
		return questionResult();
	},
};

/** The prober's registry context: the probe's own needs (probe_done —
 *  ProbeDoneContext) PLUS the job-dispatch wiring, since the owner ruling
 *  (2026-09-20) puts research + pdf in the probe phase's registry too. */
export interface ProberToolContext extends ProbeDoneContext {
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	/** Retained search-status seam; research dispatch is available keylessly. */
	searchAvailable?: () => boolean;
	/** The prober's graph-map reader (wave 7): present = the two map tools
	 *  (list_sessions / list_propositions) are registered. The composition
	 *  root passes it only when graphToolsEnabled(effective) — the graph
	 *  master switch AND the agent.graphTools toggle (settings-resolution).
	 *  Absent = the gate is closed, no map tools (tests drive this seam). */
	graphStore?: GraphStore;
}

/** The prober's tool set: probe quiz (no nodeId) + ask + the learner-fs
 *  set + probe_done + the two phase-omnipresent job dispatch tools +
 *  (wave 7, gated) the graph-map reader. `enabled` is the resolved
 *  settings seam (core/pending.ts): any tool explicitly false is dropped
 *  from the registry. probe_done stays always-on regardless — it is how
 *  the phase ENDS; a prober that can never conclude is a lockout. */
export function createProberTools(
	ctx: ProberToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	// probe_done is re-added AFTER the filter, always-on by construction — it
	// is how the phase ENDS; a prober that can never conclude is a lockout.
	const done = probeDoneTool(ctx);
	// The job tools build over the SAME context/gates as the teacher's
	// (one builder, one gating semantic); the prober carries a SUBSET:
	const jobs = jobTools({
		chatId: ctx.chatId,
		jobStore: ctx.jobStore,
		spawn: ctx.spawn,
		searchAvailable: ctx.searchAvailable,
	});
	// Quizzing mechanics (owner 2026-09-27): free-recall swaps the probe
	// quiz for the probe explain — one quizzing tool at a time, whichever
	// the settings arm. ask stays always-on. The registry keys are the
	// PHASE names (probe/recall, owner 2026-10-09) — distinct from the
	// teach tools so the schema boundary is visible to the model.
	const mechanics = quizMechanics(enabled);
	// The armed quizzing tool, widened to the registry's heterogeneous
	// AgentTool record BEFORE the filter (a conditional spread of two
	// differently-typed literals makes the whole object's type a union —
	// unusable as Record<string, AgentTool<any>> downstream).
	const quizzing: Record<string, AgentTool<any>> =
		mechanics === "free" ? { recall: probeExplainTool } : { probe: probeQuizTool };
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the standard argument heal over the WHOLE registry — every tool,
	// not just the one the latest wobble incident landed on.
	return healToolRecord({
		...filterEnabledTools(
			{
				...quizzing,
				ask_user_question: askUserQuestionTool,
				// The learner-filesystem set is always-on (user-decided 2026-09,
				// sources v1): the prober inspects and LOCATES learner-referenced
				// files while assessing the edge. Read-only by construction.
				read: readTool,
				ls: lsTool,
				find: findTool,
				grep: grepTool,
				// Job dispatch in the probe phase (owner ruling, 2026-09-20):
				// research + pdf are ALWAYS available in every phase — the
				// prober can verify facts or read learner PDFs while assessing.
				// demo/visual stay teach-phase-only (they need the lesson's plan
				// context). Same user-toggle filtering as the teacher; research
				// remains available without a search-provider key.
				...(jobs.research ? { research: jobs.research } : {}),
				pdf: jobs.pdf!,
				// The map reader (wave 7): present only when the settings gate
				// opened.
				...(ctx.graphStore
					? proberGraphTools({ chatStore: ctx.chatStore, graphStore: ctx.graphStore })
					: {}),
				...done,
			},
				withoutMechanics(enabled),
			),
			...done,
		});
}

// ─── the teacher's question tools (quiz carries the position field) ──────────

/** The nodeId-against-live-tree check the teacher's quiz chains after the
 *  shared authoring contract (the old superRefine, verbatim). */
function nodeIdProblem(ctx: Pick<PlanToolContext, "chatId" | "chatStore">, nodeId: string): string | null {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const known = record?.tree?.nodes.map((n) => n.id) ?? [];
	if (!known.includes(nodeId)) {
		return (
			`nodeId "${nodeId}" matches no node in this session's plan map. ` +
			(known.length > 0
				? `Copy one of your plan_init slugs exactly (${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}).`
				: "No plan map exists yet — call plan_init before posing quizzes.")
		);
	}
	return null;
}

/** Build the teach-side quiz tool for one request (exported for tests): the authoring contract
 *  + the per-session plan-nodeId validation (both run in execute — the
 *  grading contract is untouched). Reads the LIVE chat record, so rewrites
 *  mid-turn are honored, and with no tree yet every nodeId is rejected.
 *  nodeId is REQUIRED (owner ruling 2026-09-26): the untagged ad-hoc quiz is
 *  gone — off-map checks route through ask_user_question, and the teach
 *  seam (first tagged quiz) is structurally guaranteed. */
export function teachQuizToolFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): AgentTool<typeof quizInputObject> {
	return {
		name: "quiz",
		label: "quiz",
		description: quizDescription({ name: "quiz", nodeId: true, types: true }),
		parameters: quizInputObject,
		prepareArguments: prepareQuestionArguments,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...quizInputProblems(input)];
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
}

export interface TeacherToolContext extends PlanToolContext {
	/** Job-tool wiring (sub-agent dispatch): the job store + the runner's
	 *  spawn seam. The composition root injects both. */
	jobStore: JobStore;
	/** Fire the background runner for a freshly created job. The tool input
	 *  rides along — the spawn fires mid-stream, before the tool part is
	 *  persisted to the transcript (a transcript scan would race it). */
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	/** Retained search-status seam; research dispatch is available keylessly. */
	searchAvailable?: () => boolean;
}

/**
 * Per-request teacher tool registry: teach questions (validated nodeId) +
 * plan tools + job tools, all closing over the ctx.
 *
 * `enabled` is the resolved settings seam (core/pending.ts EnabledTools —
 * Platform's chat-handler wiring passes it through from settings). Today
 * only the sub-agent tools (research/demo/visual) are user-toggleable, but
 * the filtering is GENERIC: any name explicitly false is dropped, so
 * future toggleables (question-tool variants, …) need no change here.
 * Absent/undefined = enabled — tests and old records see today's set.
 */
/** The quizzing mechanics (owner 2026-09-27): `tools.explain === true` in
 *  the resolved settings ⇒ free-recall checks (explain armed, quiz dropped)
 *  — anything else ⇒ multiple choice, exactly today's set. Mechanics-
 *  managed, NOT individually toggleable: quiz/explain never pass through
 *  filterEnabledTools (the 2026-09-19 wedge ruling stands — a quiz-less
 *  prober collapses its assessment flow). */
export function quizMechanics(enabled?: EnabledTools): "choice" | "free" {
	return enabled?.explain === true ? "free" : "choice";
}

/** Strip the mechanics keys so filterEnabledTools can never drop the
 *  quizzing tools (the derivation above is their only switch). */
function withoutMechanics(enabled?: EnabledTools): EnabledTools | undefined {
	if (!enabled) return undefined;
	const { explain: _e, quiz: _q, ...rest } = enabled;
	return rest;
}

export function createTeacherTools(
	ctx: TeacherToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	// Quizzing mechanics (owner 2026-09-27): free-recall swaps the teach
	// quiz for the teach explain — one quizzing tool at a time, whichever
	// the settings arm. ask stays always-on.
	const mechanics = quizMechanics(enabled);
	// Same widening as the prober's (see above) — the conditional spread of
	// two differently-typed literals collapses into an unusable union type.
	const quizzing: Record<string, AgentTool<any>> =
		mechanics === "free" ? { explain: teachExplainToolFor(ctx) } : { quiz: teachQuizToolFor(ctx) };
	// healToolRecord — same standard as the prober's registry (above).
	return healToolRecord(
		filterEnabledTools(
			{
			...quizzing,
			ask_user_question: askUserQuestionTool,
			// The learner-filesystem set is always-on (user-decided 2026-09,
			// sources v1): the teacher locates and reads learner-referenced
			// files on its own terms — nothing auto-injects. Read-only by
			// construction (fs-shared.ts).
			read: readTool,
			ls: lsTool,
			find: findTool,
			grep: grepTool,
			...planTools(ctx),
			...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn, searchAvailable: ctx.searchAvailable }),
		},
		withoutMechanics(enabled),
		),
	);
}

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "./tool-execute.ts";
import { providerEventObserver } from "./provider-events.ts";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	type ProbeDoneContext,
	type ProberToolContext,
	type TeacherToolContext,
} from "./tools.ts";
import { practiceTools, type PracticeToolContext } from "./tools/practice.ts";
import { healToolRecord, withArgumentHeal } from "./tools/heal.ts";
import { sendToUserTool } from "./tools/send-to-user.ts";
import { createReadTool, readTool } from "./tools/read.ts";
import { CLAUDE_CODE_PROVIDER } from "./claude-code/constants.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { QUESTION_TOOLS, type EnabledTools } from "../core/pending.ts";
import { toLlmMessages, nativeInputCause, PRACTICE_PROBLEM_TOOL } from "../core/native-messages.ts";
import type { ChatGPTRequestCycle } from "./chatgpt-request-cycle.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";

/**
 * The two teaching-side agents (docs/probe-teach-split.md): the PROBER and
 * the TEACHER. Same transcript, different prompts and tool sets; the
 * chat-handler constructs ONE per request off the transcript's seam
 * (probe_done = teacher) — the STATELESS per-turn engine (docs/
 * pi-engine-swap.md §2): the persisted record is the source of truth, the
 * agent is rebuilt from it every POST and discarded at turn end.
 *
 * Engines are injectable so tests can pass a scripted faux engine and drive
 * deterministic lessons (see tests/chat-flow.test.ts).
 *
 * System prompts are COMPOSED per agent: system-prompt.md (the shared base:
 * agent, voice, philosophy, accuracy) + every numeric-prefix fragment in
 * that agent's directory (src/agent/prompts/prober/ or
 * src/agent/prompts/teacher/), in sorted filename order, then the shared/
 * fragments as a trailing appendix (question tools, learner files,
 * formatting) — the 2026-09-27 reorder: the agent's job and method lead,
 * the mechanics trail. Joined with `---` separators.
 *
 * ONLY numeric-prefix files load — the loader enforces the convention, so
 * non-fragment documentation (README.md, …) can live in the directories
 * without ever leaking into the model's prompt.
 */

/** Which agent's prompt directory to compose. Practice (2026-10-04)
 *  composes ONLY its own directory — see prompt-segments.ts. */
export type AgentKind = "prober" | "teacher" | "practice";

// P2 (2026-09-19): segment discovery + override resolution live in ONE
// canonical place now — src/store/prompt-overrides.ts (listSourceSegments
// mirrors this loader's rules, shared/ included). The agent imports it for
// the static-file seam; the local fragment discovery helpers are retired.

/** Exported for tests: assert what composes into the model's prompt.
 *  Composition order: shared base → shared/ fragments (both agents, the
 *  sources-v1 seam for cross-agent doctrine) → the agent's own fragments.
 *
 *  P2 reconciliation (2026-09-19): composition is DELEGATED to the store
 *  module's effectivePromptSegments — one canonical segment-discovery
 *  rule (its listSourceSegments mirrors this loader's, now including
 *  shared/) — so per-segment OVERRIDES ride the same path: a segment
 *  whose switch is ON and whose override file exists composes the
 *  override text instead of the source. `switches` is the settings
 *  record's agent.prompts map (absent key = off), threaded per turn via
 *  AgentBuildOptions.promptSwitches; a switches-less call composes pure
 *  source (byte-identical to the pre-refactor loader — pinned in
 *  tests/prompt-overrides.test.ts). Overrides are a static-file read
 *  through config paths, not request state — the store import carries no
 *  chat/job machinery. */
export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

// The switch-free source composition, cached per kind (module-load once).
// With promptSwitches provided, baseAgentOptions composes FRESH per turn —
// an override file written while its switch is ON must flip the next
// turn's composition; the cache serves only the switches-less path.
const composedInstructions: Record<AgentKind, string> = {
	prober: composeInstructions("prober"),
	teacher: composeInstructions("teacher"),
	practice: composeInstructions("practice"),
};

// Money channel (wave 4): the chat-handler passes a per-turn collector;
// every model call's usage lands in the chat record's turns log
// (ChatStore.appendTurnUsage). The narrow param keeps the seam honest.
export type StepUsageCollector = (usage: Usage) => void;

/** Per-request construction options (the handler wires all of these). */
export interface AgentBuildOptions {
	/** Model + stream function — tests inject a scripted faux engine. */
	engine?: PiEngine;
	callPurpose?: { background: boolean };
	requestCycle?: ChatGPTRequestCycle;
	/** The initial transcript, as pi messages (the record IS agent state). */
	messages?: AgentMessage[];
	/** Money channel: one call per model request. */
	onUsage?: StepUsageCollector;
	/** Tests may pass a bare tool registry to drive deterministic flows.
	 *  An explicit registry is NEVER toggle-filtered — the caller owns it. */
	tools?: Record<string, AgentTool<any>>;
	/** The resolved per-user tool toggles (core/pending EnabledTools — the
	 *  2026-09-19 P2 bridge: Platform's chat-handler passes
	 *  effective.agent.tools; the factories drop any tool explicitly false.
	 *  THE DEFINITIVE toggleable set is TOGGLEABLE_TOOLS (job tools only);
	 *  the filtering is generic, but writes validate against the list). */
	toolToggles?: EnabledTools;
	/** Per-segment system-prompt override SWITCHES (the settings record's
	 *  agent.prompts map, absent key = off — same keys the settings routes
	 *  and effectivePromptSegments use). Provided → the prompt composes
	 *  fresh per turn, honoring enabled overrides (switch on + file
	 *  exists); absent → the cached pure-source composition. */
	promptSwitches?: Record<string, boolean>;
	/** Native conversation identity: the existing persisted chat id, reused
	 * across reconstructed prober, teacher, and practice Agents.
	 * Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream events
	 *  (pre-normalization) append to data/debug/provider-events/
	 *  <chatId>.jsonl via providerEventObserver — the GLM-truncation /
	 *  DeepSeek-id incident layer. Absent or env-off → no observer. */
	chatId?: string;
}

/**
 * The turn's question-stop rule (docs/pi-engine-swap.md §2; Wave A
 * 2026-09-26, owner Option A): a question tool call (quiz /
 * ask_user_question) that RESOLVED — its synthetic "question posed" result
 * is not an error — ends the run: the learner's answer arrives as the next
 * POST. A call that FAILED authoring validation (error result) must NOT
 * stop the run — the model retries within the same turn, exactly the old
 * InvalidToolInputError semantics.
 *
 * Question results also carry terminate: true (tool-execute's
 * questionResult), so single-question batches stop natively at the pi
 * loop's own batch check; this finishTurn hook (0.87.1 rename of
 * shouldStopAfterTurn) is the
 * belt-and-suspenders HALF for the mixed batch (a question + other calls
 * in one message) that terminate-only semantics would let run on — the
 * learner cannot answer while a turn is in flight (per-chat 409), so a
 * cleanly-posed question MUST always end the turn. Practice's problem pose
 * has the same wait-for-the-learner contract, including mixed output/problem
 * batches; failed poses must still retry. maxTurns is gone
 * (owner ruling 2026-09-25: no maximum-agent-turns net on the teaching
 * turn).
 */
function makeQuestionStopper(kind: AgentKind) {
	return (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; isError?: boolean }>;
	}): boolean => {
		const called = new Set(
			context.message.content
				.filter((c) => c.type === "toolCall" && c.name !== undefined && (
					(QUESTION_TOOLS as readonly string[]).includes(c.name) ||
					(kind === "practice" && c.name === PRACTICE_PROBLEM_TOOL)
				))
				.map((c) => c.id!),
		);
		if (called.size === 0) return false;
		// Stop only when every question/problem pose resolved cleanly.
		for (const result of context.toolResults) {
			if (called.has(result.toolCallId) && result.isError) return false;
		}
		return true;
	};
}

function baseAgentOptions(kind: AgentKind, opts: AgentBuildOptions, tools: AgentTool<any, any>[]) {
	// Practice never reaches the role fallback (the handler ALWAYS injects
	// the session's conversation engine — practice rides the same
	// conversation-spec resolution as teaching); the cast keeps AgentKind
	// ("practice" is not a ModelRole) honest about that.
	const engine = opts.engine ?? piEngineFor(kind as "prober" | "teacher");
	const stopper = makeQuestionStopper(kind);
	const systemPrompt = opts.promptSwitches
		? composeInstructions(kind, opts.promptSwitches)
		: composedInstructions[kind]!;
	// Debug recorder (owner, 2026-10-04): raw provider events when
	// LH_PROVIDER_EVENTS=1 and the caller handed a chatId; undefined is
	// the normal no-observer path (tests, env-off).
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, kind) : undefined;
	const seenInputs = new Set((opts.messages ?? []).map((m) => (m as { id?: string }).id).filter(Boolean));
	const agent = new Agent({
		identity: APP_IDENTITY,
		sessionId: opts.chatId,
		initialState: {
			systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			// Conditional registry inclusion, like the graph-tool gates: when
			// closed, neither the tool nor its usage instructions reach the model.
			// Match Claude across providers (including OpenRouter), not the API
			// transport. Explicit test registries remain caller-owned.
			tools: [
				...tools.map((tool) => tool.name === "read" && tool.execute === readTool.execute
					? { ...tool, execute: createReadTool(engine.model).execute as AgentTool<any>["execute"] }
					: tool),
				...(opts.tools === undefined && (engine.model.provider === CLAUDE_CODE_PROVIDER || engine.model.id.toLowerCase().includes("claude"))
					? [withArgumentHeal(sendToUserTool)]
					: []),
			],
			messages: opts.messages ?? [],
		},
		streamFn: engine.streamFn,
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		// 0.87.1: shouldStopAfterTurn → finishTurn. Same call point (after
		// tool results attach, before turn_end) and `{ action: "end" }` still
		// exits BEFORE the steering poll — the parked-marker stranding our
		// Wave C registerLiveAgent-before-runPiTurn design depends on.
		// undefined preserves normal scheduling (the old boolean false).
		finishTurn: (turn) => (stopper(turn) ? { action: "end" } : undefined),
		// Wave C (2026-09-26, owner correction same day): markers handed to a
		// live run drain from pi's STEERING queue — the lesson loop is one
		// continuous teach→quiz→teach run, so delivery must inject at turn
		// boundaries INSIDE the run, not wait for it to stop (follow-ups).
		// "all" joins every handed marker at one boundary, matching the idle
		// wake's carry-everything semantics (the default "one-at-a-time"
		// would spend one teacher turn per marker).
		steeringMode: "all",
		// Wave B (owner-approved 2026-09-26): the model-facing conversion is
		// THE app seam — markers flatten to their canonical user text
		// (HANDOFF_TEXT / steer text, all single-sourced),
		// UI-only markers (plan-block) drop, the app's id fields strip, and
		// an abort's dangling question call gets its INTERRUPTED result. It
		// must never throw (pi's convertToLlm contract).
		convertToLlm: toLlmMessages,
		prepareRequest: (request) => {
			if (opts.callPurpose) {
				let learner = false, automatic = false;
				const messages = request.context.messages;
				for (const message of messages) {
					const id = (message as { id?: string }).id;
					const cause = nativeInputCause(message, messages.slice(0, messages.indexOf(message)));
					if (cause === "neutral") continue;
					if (id && seenInputs.has(id)) continue;
					if (id) seenInputs.add(id);
					if (cause === "learner" && id) learner = true;
					else automatic = true; // missing/unrecognized identity never grants foreground
				}
				if (automatic) opts.callPurpose.background = true;
				else if (learner) opts.callPurpose.background = false;
			}
			opts.requestCycle?.prepare(request);
		},
	});
	if (opts.onUsage) {
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
				// A cancelled call is not a billed step (partial/estimated
				// usage on an aborted message is not money spent).
				if (event.message.stopReason === "aborted" || !usageWasAdmitted(event.message.usage) || (opts.requestCycle && !opts.requestCycle.acceptsUsage(event.message))) return;
				opts.onUsage!(event.message.usage);
			}
		});
	}
	return agent;
}

/**
 * The PROBER (agent A): the quizzing tool (quiz, or explain under free
 * recall — no nodeId either way) + ask + probe_done, lean on
 * probing doctrine. Its whole job is bracketing the learner's edge and
 * concluding with the assessment (probe_done) — which also queues the
 * handoff wake (see tools/probe.ts) and is the transcript seam the
 * handler keys teacher construction on.
 */
export function createProberAgent(ctx: ProberToolContext, opts: AgentBuildOptions = {}) {
	return baseAgentOptions("prober", opts, Object.values(createProberTools(ctx, opts.toolToggles)));
}

/**
 * The TEACHER (agent B): enters at planning (the probe is already
 * concluded — its assessment is in the transcript), owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export function createTeacherAgent(
	// Optional so tests can construct a bare mock-driven agent (no storage
	// wiring): without ctx the tools fall back to the validation-free
	// question set. The handler ALWAYS passes ctx (the composition root).
	ctx?: TeacherToolContext,
	opts: AgentBuildOptions = {},
) {
	const tools = opts.tools ?? (ctx ? createTeacherTools(ctx, opts.toolToggles) : bareQuestionTools());
	return baseAgentOptions("teacher", opts, Object.values(tools));
}

/** The bare teach question set (tests, bare agents): quiz with the shared
 *  authoring refinement (quizInputProblems, run in execute — returns an
 *  invalidInputResult isError result the model retries on, pi 1.0
 *  convention) but NO per-session nodeId check (no record to read),
 *  plus ask. */
export function bareQuestionTools(): Record<string, AgentTool<any>> {
	// A typed const (not an inline literal): the specific AgentTool typing
	// gives execute its precise Static input; heterogeneous records take
	// AgentTool<any>, whose loose Static would smudge it to unknown.
	const quiz: AgentTool<typeof quizInputObject> = {
		name: "quiz",
		label: "quiz",
		description: "Ask the learner a graded question.",
		parameters: quizInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = quizInputProblems(input);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the bare quiz carried NO prepareArguments at all — not even the
	// options-unwrap; now it gets the full standard heal like every tool.
	return healToolRecord({
		quiz,
		ask_user_question: askUserQuestionTool,
	});
}

/**
 * The PRACTITIONER (practice sessions, owner design 2026-10-04): built
 * from turn 1 of a kind:"practice" session — no prober→teacher split,
 * no plan tools, no question tools. Its ENTIRE registry is
 * problem + conclude (tools/practice.ts); the doctrine prompt
 * (prompts/practice/) carries the method. A successful problem pose ends
 * the run, natively for a problem-only batch and via the shared stop hook
 * for a mixed batch (for example, send_to_user + problem).
 */
export function createPracticeAgent(ctx: PracticeToolContext, opts: AgentBuildOptions = {}) {
	const tools = opts.tools ?? practiceTools(ctx);
	return baseAgentOptions("practice", opts, Object.values(tools));
}

export type ProberAgent = ReturnType<typeof createProberAgent>;
export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
export type PracticeAgent = ReturnType<typeof createPracticeAgent>;
export type TeachingAgent = ProberAgent | TeacherAgent | PracticeAgent;


/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../native-messages.ts";
import type { Phase3 } from "../phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan.ts";
import type { EmissionStats } from "./graph.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** One persisted session: data/chats/<id>.json. Wave B (owner-approved
 * 2026-09-26): the stored messages are pi-NATIVE history (LhMessage — the
 * agent loop's own shapes, provider/model/usage/thinkingSignature stamped
 * by pi) — the canonical session record IS the agent state; replay is
 * `state.messages = record.messages` + continue(). The client-shaped view
 * is the client's own grouping fold (core/view.ts, Wave D) — a pending quiz
 * is an unanswered question tool call, which is exactly what makes
 * resume-mid-question free. */
/** The session's kind (practice sessions, owner 2026-10-04): "teach" is
 *  the default and ABSENT on pre-practice records (no migration — absence
 *  reads as teach); "practice" marks an adaptive-practice session — the
 *  practice agent, its two tools, no extraction, no graph writes. */
export type ChatKind = "teach" | "practice";

export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** The session's kind — absent = teach (pre-practice records). */
	kind?: ChatKind;
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
	/** Append-only usage log (observability, 2026-09): one entry per model
	 * turn. DELIBERATELY a parallel log, not per-message metadata — the client
	 * re-POSTs its message list every turn and its copies never carry
	 * server-stamped fields, so anything inside message objects gets clobbered
	 * by the next persist. Keyed by messageId so the transcript view can fold
	 * each entry onto its message; aggregates are folds over this log
	 * (core/prices.ts). */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage log (2026-09 observability):
	 *  one entry per finished pipeline run on THIS chat — extraction is real
	 *  spend too. Same parallel-log discipline as `turns` (nothing rides
	 *  inside messages). Keyed by startedAt; idempotent appends. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** SCHEMA STAMP (schema-versioning wave, owner 2026-10-10): LAZY v1 —
	 *  existing records stay unstamped (absence reads as v1); every write
	 *  stamps the current version. A record stamped NEWER than this build
	 *  (the downgrade scenario) is REFUSED on read: a read-modify-write
	 *  store must never rewrite what it doesn't understand. */
	version?: number;
}

/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 1;

/** The conversation agents' runtime model choice (model-control wave,
 *  2026-09-12): a per-chat override of config.ts's pinned prober/teacher
 *  spec. Absent fields fall back to config; written by the model picker
 *  (PUT /api/chats/[id]/settings) and read at turn composition — the
 *  agents are stateless per turn, so a change takes effect on the next
 *  turn by construction. Background sub-agents are NEVER overridden
 *  (config-pinned: they're infrastructure, not conversation). */
export interface ChatSettings {
	/** pi-ai catalog coordinates: the provider that owns the model. Only
	 *  "openrouter" is configured today; the field exists so a second
	 *  provider needs no schema change. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list
	 *  (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
}


// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it
 *  billed (CallUsage per agent step). Steps, not a sum: cost and context
 *  folds happen at read time (core/prices.ts). */
export interface ExtractionStageUsage {
	/** The model that ran this stage, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record.
 *  Appended to the chat's `extractions` log when the run ends — success or
 *  failure, because money was spent either way; `stats` is present only
 *  when the merger actually ran. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic —
	 *  no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — the SDK's LanguageModelUsage
 * flattened to the fields we persist (undefined = provider didn't report;
 * renderers show absent, never zero). */
export interface CallUsage {
	/** Pi-normalized fresh input tokens; cache buckets are disjoint. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call (OpenRouter bills writes
	 * for some providers; undefined = not reported/not billed). */
	cacheWriteTokens: number | undefined;
	/** Subset of cacheWriteTokens written with one-hour retention. Missing
	 * on older logs; new native captures explicitly record zero if absent. */
	cacheWrite1hTokens?: number;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** One billing turn: one full invocation of the teacher (a client turn or a
 * wake turn — same handler, same log). A turn with tool calls spans several
 * agent steps, and each step bills separately. Capture lands at the persist
 * seam (server); cost is INFERRED at read time from core/prices.ts. */
export interface TurnUsage {
	/** Unique per REQUEST (turn): one invocation of the handler — the
	 *  idempotency key for the append-only log. Continuation turns share a
	 *  response message id (the SDK coalesces them); keying on messageId
	 *  would swallow their usage. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────

/** Payload of the persisted `data-plan-block` UI part (2026-09 design): a
 * SNAPSHOT of the plan at the moment it changed, rendered as a block in the
 * chat flow. Attached to the assistant message that carries the plan_init
 * tool call (kind "full") or the answered check quiz part (kind
 * "neighborhood"). Data parts never reach the model (convertToModelMessages
 * drops them) — the block is pure UI history, reappearing identically on
 * reload because it lives in the record.
 *
 * Rendering contract: a "full" block renders the whole DAG borderless,
 * horizontally filling the chat column, natural height; a "neighborhood"
 * block renders current node + direct parents + direct children in its own
 * small container, the current node glowing — clearly a fragment, not the
 * whole plan. Clicking either opens the full plan in a popup. */

/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart.
 *
 *  REASONING-FIRST PACING (owner, 2026-09-26): the wake is the one per-turn
 *  cue on the launch turn — the old one-liner read as a dispatch order
 *  ("author now") and the teacher skipped the deliberation the planning
 *  fragment asks for. So the wake paces it: reason out the optimal way to
 *  teach THIS person THIS thing BEFORE plan_init. Honest to the machinery
 *  — plan_init is still the first tool, the plan map still the first
 *  artifact, and presenting still ends the turn (the verdict death,
 *  2026-09-26: the learner's next message is a natural reply — a change
 *  request or the go-ahead). */
export const HANDOFF_TEXT =
	"Next: plan the full teaching arc from my current understanding to the goal understanding. " +
	"Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
	"Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
	"Take your time here and really think this through. " +
	"When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

// ─── Practice sessions (owner, 2026-10-04) — marker + ack texts ──────────────
// Single-sourced here per the marker law: the model-facing text of every
// custom marker lives in core/contracts, never in the flattening seam.

/** The model-facing register of a thinking submission (newThinkingMessage
 *  prefixes the learner's text with this label). Hints and commits ride
 *  one channel — the label is the ONLY difference the model sees. */
/** The single submission label (owner round, 2026-10-05): one send
 *  lane — whether a submission claims an answer is read from the text,
 *  not declared by a button. */
export const THINKING_LABEL = "Your thinking";

/** The conclude tool's ack — shared by the executed call (agent layer) and
 *  the dismissal-synthesized pair (input-events), so a concluded problem
 *  reads identically to the model however it concluded. Owner round 16:
 *  the turn ENDS after concluding (a system-prompt law, no tool-level
 *  terminate — the model may speak its closing words first, then must
 *  stop calling tools); the next problem waits for the learner's
 *  explicit go-ahead. */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

/** The learner's explicit move-on signal (owner round 16, 2026-10-06):
 *  the model-facing text of the practice-next marker — single-sourced
 *  like THINKING_LABEL. The button/Enter-on-empty path appends the
 *  marker; the model reads this and poses (or wraps) per the doctrine. */
export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

/** The compaction marker's model-facing header (owner round 14,
 *  2026-10-05). The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


export interface PlanBlockData {
	/** Only "full" survives (the 2026-09-11 pivot): the plan renders IN
	 *  FLOW once, at authoring. The neighborhood fragments are retired —
	 *  position derives live from the transcript (the persistent DAG
	 *  window is the successor). */
	kind: "full";
	at: string;
	/** The current node at snapshot time (the glow target; null = none). */
	current: string | null;
	/** All nodes of the authored tree. Statuses are the snapshot's,
	 * derived at emission time — the block never re-derives at render. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** The list view's shape (messageCount instead of full messages) + the
 *  per-session status the picker renders. `phase` and `pendingQuestion`
 *  derive from the stored record (tree + messages); the store computes
 *  them in listChats. Liveness (`busy`) is NOT record-derived — the API
 *  route merges it in (see ChatListItem).
 *
 *  Phase semantics (three phases, event-driven — docs/probe-teach-split.md
 *  §4): probe ends at the concluded probe_done, plan ends at the successful
 *  plan_init; derived from the transcript (core/phases.ts phaseAt3).
 */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Normalized kind (absent record field reads as teach). */
	kind: ChatKind;
	messageCount: number;
	/** The session's current phase, derived from the stored plan tree. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** Practice sessions (2026-10-04): a posed problem with no conclude —
	 *  the sidebar meta's "Problem waiting". Absent on teaching sessions. */
	pendingProblem: boolean;
	/** The record's model-control settings — rides the list payload via the
	 *  summary spread (the picker never needs it from here; the full record
	 *  is its source). */
	settings?: ChatSettings;
}

/** The sidebar's session row: a summary + live liveness. The chats list
 *  route attaches `busy` from the turn-liveness registry ONLY — a running
 *  teach turn (owner, minimal-color round: background jobs no longer
 *  count; the sidebar's Background agents section is their channel, and
 *  the row spinner means exactly "a turn is in flight"). The store itself
 *  can't see liveness (import law: store never imports server), hence the
 *  split at exactly the record/liveness seam. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** Live compaction liveness (turn-liveness's twin): true while a
	 *  background context compaction holds the chat's model gate. The
	 *  route attaches it from the compaction registry — never
	 *  record-derived (the marker persists, the RUN is ephemeral). */
	compacting: boolean;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * components/chat.tsx renders any tool part it doesn't specially handle via
 * components/artifacts/index.ts's registry, keyed by tool name ("research",
 * "demo", "visual", …). Workers add renderers there — chat.tsx is off-limits
 * to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side fold (owner round 17): the whole problem-call
		 * arguments joined onto the conclude part by projectView — the
		 * observability drawer's data. */
		problemInput?: unknown;
		/** The view-seam join for conclude cards (owner round, 2026-10-05):
		 *  the modelSolution committed at POSE time, folded onto the part by
		 *  projectView — the reveal is never re-authored. */
		reveal?: unknown;
	};
}

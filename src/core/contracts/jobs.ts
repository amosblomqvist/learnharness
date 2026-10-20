/**
 * Sub-agent job contracts — the async ack-and-steer protocol
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
import { totalInputOf, usagePresenceOf, type CallUsage, type UsagePresence } from "./chat.ts";
import type { LhMessage, LhMarkerMessage } from "../native-messages.ts";
import { newHandoffMessage } from "../native-messages.ts";

// ─── Async sub-agent jobs (vision §2.5; plan.md Wave 0 protocol) ────────────

export type JobKind = "research" | "demo" | "visual" | "pdf";
export type JobStatus = "running" | "done" | "error";

export interface JobRecord {
	id: string;
	kind: JobKind;
	chatId: string;
	/** The tool part this job fulfills. */
	toolCallId: string;
	status: JobStatus;
	/** Latest human-readable activity line, e.g. `web_search: "sigma.js v3"`. */
	activity: string;
	createdAt: string;
	updatedAt: string;
	/** The sub-agent's result (steer-artifact payload). */
	result?: unknown;
	error?: string;
	/** Money channel (observability, 2026-09): accumulated token usage of
	 * the sub-agent's run, written by the runner as steps complete. Cost is
	 * inferred at read time (core/prices.ts). Absent on pre-2026-09 jobs and
	 * until the runner's capture lands — renderers show "—", never zero. */
	usage?: JobUsage;
	/** Subscription generation provenance (source-aware execution, issue
	 *  #8): the instance-subscription generation this job was spawned
	 *  under. ABSENT = no subscription session in the spawning scope — a
	 *  subscription-source job without it is refused on recovery, never
	 *  replayed against a newer account. Optional and record-compatible:
	 *  no schema version bump, no migration of old records. */
	subscriptionGeneration?: string;
}

/** A sub-agent run's accumulated usage — the same accounting shape as a
 * chat turn (contracts/chat.ts CallUsage), flattened to one running total
 * plus a step count. Token fields are optional exactly like CallUsage: a
 * field NO model call reported stays undefined — absent is not zero (the
 * money-channel doctrine; cost renders "—", never $0). */
export interface JobUsage {
	/** The model that ran the sub-agent, provider-qualified ("provider:id" —
	 *  model slots wave, 2026-09-20; matches PRICES' uniform keys). */
	model: string;
	/** Running totals summed over the run's model calls so far. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	reasoningTokens: number | undefined;
	/** How many model calls the run has made (each bills separately). */
	steps: number;
	/** The MOST RECENT model call's accounting (2026-09 dock contract): the
	 *  per-blob context line reads last-step input+output against the
	 *  model's LIVE catalog limit (server-joined onto the activity feed —
	 *  never the cumulative totals, never a client-side table). Absent
	 *  until the first call completes; absent provider fields stay absent
	 *  (never zero). */
	lastStep?: CallUsage;
}

/** The per-model-call usage shape we fold into JobUsage — the SDK's
 * LanguageModelUsage narrowed structurally (no runtime "ai" import: any
 * object with these fields folds, including the real thing and test fakes). */
export interface UsageStepLike {
	inputTokens?: number | undefined;
	inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
	outputTokens?: number | undefined;
	outputTokenDetails?: { reasoningTokens?: number } | undefined;
}

/** pi-ai's Usage shape (input/output/cacheRead/cacheWrite/reasoning?) →
 * UsageStepLike. Structural — no pi import here; the engine band maps at
 * its boundaries.
 *
 * `presence` is the supplier's FIELD-LEVEL usage presence (see
 * messageUsagePresence, contracts/chat.ts): the SDK always carries numbers,
 * so an unreported field must project to UNKNOWN (undefined) rather than a
 * fake zero. Each reported field survives on its own (plan law: preserve
 * each obtained token field), and the reported cache parts are added back
 * into the total input the fold prices against. */
export function piUsageToStep(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
}, presence: boolean | Partial<UsagePresence> = true): UsageStepLike {
	const reported = usagePresenceOf(presence);
	const cacheReadTokens = reported.cacheRead ? usage.cacheRead : undefined;
	const cacheWriteTokens = reported.cacheWrite ? usage.cacheWrite : undefined;
	const reasoningTokens = reported.reasoning ? usage.reasoning ?? 0 : undefined;
	const inputTokenDetails =
		cacheReadTokens !== undefined || cacheWriteTokens !== undefined
			? { cacheReadTokens, cacheWriteTokens }
			: undefined;
	return {
		inputTokens: reported.input ? totalInputOf(usage, reported) : undefined,
		outputTokens: reported.output ? usage.output : undefined,
		inputTokenDetails,
		outputTokenDetails: reasoningTokens !== undefined ? { reasoningTokens } : undefined,
	};
}

/** Fold one model call's usage into the run's running total (pure). A
 * field neither the total nor the step reported stays undefined; once
 * reported, later unreported calls contribute 0. The `steps` counter is
 * the billing count: one per model call, reported or not. */
export function accumulateJobUsage(
	total: JobUsage | undefined,
	model: string,
	step: UsageStepLike,
): JobUsage {
	const add = (a: number | undefined, b: number | undefined): number | undefined =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
	return {
		model,
		inputTokens: add(total?.inputTokens, step.inputTokens),
		outputTokens: add(total?.outputTokens, step.outputTokens),
		cacheReadTokens: add(total?.cacheReadTokens, step.inputTokenDetails?.cacheReadTokens),
		cacheWriteTokens: add(total?.cacheWriteTokens, step.inputTokenDetails?.cacheWriteTokens),
		reasoningTokens: add(total?.reasoningTokens, step.outputTokenDetails?.reasoningTokens),
		steps: (total?.steps ?? 0) + 1,
		lastStep: {
			inputTokens: step.inputTokens,
			outputTokens: step.outputTokens,
			cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
			reasoningTokens: step.outputTokenDetails?.reasoningTokens,
		},
	};
}

/**
 * THE ASYNC PROTOCOL — "ack now, steer later" (the pi sub-agents model,
 * vision §2.5):
 *
 *  1. Job tools (research / demo / visual / pdf) are SERVER-EXECUTED. The model
 *     calls one MID-TURN; execute creates the job record, fires the
 *     background runner, and resolves IMMEDIATELY with an acknowledgement
 *     ("dispatched — continue your turn"). The teacher's turn does NOT end
 *     at the call: it keeps teaching, may dispatch other independent jobs
 *     (full parallelism), and ends whenever it ends. The tool part's output
 *     is the ack, forever.
 *
 *  2. The background runner (src/agent/subagents/runner.ts) runs the kind's
 *     sub-agent loop — isolated context, modelFor(role), the
 *     verify-never-one-shot doctrine (headless-tested demos, looked-at SVGs,
 *     sourced briefs) — tracking a live activity line in the job record.
 *     ONE central client poll of GET /api/jobs?chatId=… (in Chat) drives every
 *     job surface: the transcript dispatch cards (live activity by
 *     toolCallId, quiet one-liner after delivery), the sub-agents sidebar
 *     panel, and the single re-sync when a job settles.
 *
 *  3. On completion the runner builds a STEER MESSAGE (buildSubagentSteer)
 *     and hands it to the wake pipeline (src/server/jobs.ts): a user-role
 *     result-carrying native marker — the content is what the MODEL needs
 *     (the research brief, the builder's notes), plus a data-subagent-artifact
 *     part with what the UI renders (the full result: brief + sources /
 *     SVG / demo HTML). Provider conversion drops data parts, so artifact
 *     payloads never enter the teacher's context. metadata.subagentResult
 *     identifies the job; the UI renders these as sub-agent result cards,
 *     NEVER as learner interjections.
 *
 *  4. The wake pipeline delivers the steer by firing a SERVER-SIDE teacher
 *     turn through the same turn composition as a client request
 *     (handleChatRequest) — write-ahead persist, turn liveness, extraction
 *     trigger: one code path. A per-chat serialized queue: a steer waits
 *     while a turn is in flight OR a question tool part is pending (an
 *     unanswered client-side tool call breaks provider conversion — the
 *     steer fires right after the learner's continuation), then fires; a 409
 *     (a client turn raced in) retries. Delivery is idempotent per jobId, so
 *     a crashed wake can be re-entered by the stale-job recovery sweep. The
 *     job's status flips to done/error only AFTER the wake turn completes —
 *     a polling client that sees the flip re-syncs once and gets the
 *     finished record.
 *
 *     CONTINUATION COALESCING: the idle window above can starve — a
 *     quiz-chaining teacher ends every turn with a new pending check, so
 *     the gates never stay open long enough for a wake to fire. The fix:
 *     when a client turn wins the turn registry, the handler CLAIMS every
 *     queued, undelivered steer (jobs.ts claimSteers) and appends it after
 *     the learner's answer in that very turn — conversion-safe, because the
 *     answered quiz carries its output. Every answer flushes pending
 *     steers immediately; the wake pump remains for turns that end with no
 *     pending question. The pump re-checks steerDelivered right before
 *     firing, so a claim racing the pump converges to exactly one delivery.
 *
 *  5. No pending job parts ever exist, so the composer never gates on jobs
 *     (the learner can interject mid-job; the steer queues behind their
 *     turn) and job tool outputs never trigger the client-side
 *     sendAutomatically continuation — that mechanism stays quiz/ask-only.
 */

export interface ResearchToolInput {
	question: string;
	/** What the teacher needs it for — focuses the research brief. */
	context?: string;
}

export interface ResearchResult {
	brief: string;
	sources: { title: string; url: string }[];
}

export interface DemoToolInput {
	title: string;
	/** Precise brief: concept, parameters/interactions, visual style. */
	brief: string;
}

export interface DemoResult {
	title: string;
	/** Self-contained single-file HTML/JS document (sandboxed-iframe ready). */
	html: string;
	/** The builder sub-agent headlessly executed the demo before delivery. */
	tested: true;
	notes?: string;
}

export interface VisualToolInput {
	/** Precise brief for ONE visual (what it must show, exactly). */
	brief: string;
}

export interface VisualResult {
	/** Complete SVG markup (verified by the maker looking at the render). */
	svg: string;
	notes?: string;
}

/** The pdf-reader (sources v0, 2026-09): reads a learner-provided PDF on
 *  the teacher's behalf — triage, targeted extraction, look-at-the-page
 *  renders inside its own loop — and returns a text brief with page
 *  citations (user-decided: rendered images never leave the sub-agent's
 *  context; the teacher gets text). */
export interface PdfToolInput {
	/** Path to the learner's PDF (relative or absolute). */
	path: string;
	/** What the teacher needs from the document — focuses the brief. */
	question: string;
}

export interface PdfResult {
	path: string;
	question: string;
	/** The distilled brief. Page citations inside the text point at
	 *  pagesConsulted. Failure shape: /^PDF failed:/i (mirrors research). */
	brief: string;
	/** Pages the reader actually READ — extract or render output entered the
	 *  loop (the honest count for the UI badge; search-hit snippets don't
	 *  count — sources v1 split, 2026-09-19, after the "78 pages consulted"
	 *  overstatement on a long-book search-first read). */
	pagesRead: number[];
	/** Every page whose content entered the loop, search-hit context lines
	 *  included — the full audit set (the brief's citations may point here). */
	pagesConsulted: number[];
}

// ─── Sub-agent steer messages (THE ASYNC PROTOCOL §3–4) ─────────────────────
//
// Wave B (owner-approved 2026-09-26): steers are NATIVE record messages —
// LhMarkerMessage customs (role "custom"), the custom-message taxonomy's
// wake members. The model-facing text rides `content` (single-sourced
// below); the UI payload (the artifact, the abort badge) rides `details`
// and never reaches the model (toLlmMessages maps the marker to a user
// message carrying `content` only). The deterministic id (`steer_<jobId>`)
// IS the idempotency key — steerDelivered matches on it.

/** Message metadata marking a sub-agent steer (contracts.ts §3). */
export interface SubagentResultMeta {
	jobId: string;
	kind: JobKind;
	toolCallId: string;
	/** Present only on an abort steer (2026-09 abort semantics): the
	 * learner aborted the job (it lands as error "Aborted by learner");
	 * the teacher is told so its promise of a result doesn't hang
	 * silently in the lesson. */
	aborted?: true;
	/** The job's subscription generation (source-aware execution, issue
	 *  #8) — the wake runs under it, never under whatever account is
	 *  current by delivery time. */
	subscriptionGeneration?: string;
}

/** The data-subagent-artifact part payload: what the UI renders. */
export interface SubagentArtifactData {
	kind: JobKind;
	result: ResearchResult | DemoResult | VisualResult | PdfResult;
	/** The learner's pinned UI state (invert switch) riding the record. */
	ui?: { inverted?: boolean };
}

/** A result steer's marker details: the UI's meta + artifact in one
 *  payload (the projection splits it into metadata + data part). */
export interface SteerDetails extends SubagentResultMeta {
	result: ResearchResult | DemoResult | VisualResult | PdfResult;
	/** LEARNER UI state pinned onto the artifact (owner, 2026-10-07): the
	 *  invert switch's position, persisted so navigating away and back (or
	 *  restarting) keeps it. A VIEW preference — never enters the teacher's
	 *  context, never exports (the markdown engine reads `result` only). */
	ui?: { inverted?: boolean };
}

/** Set a steer message's ui.inverted (pure): returns a NEW message array
 *  with the target's details updated — no-op (same array) when the message
 *  is missing or not an invertible artifact steer. The silent route's
 *  whole body. */
export function setSteerUiInverted(
	messages: readonly LhMessage[],
	messageId: string,
	inverted: boolean,
): LhMessage[] {
	return messages.map((m) => {
		if (m.id !== messageId) return m;
		const d = (m as LhMarkerMessage).details as Partial<SteerDetails> | undefined;
		if (!d || (d.kind !== "demo" && d.kind !== "visual")) return m;
		return { ...m, details: { ...d, ui: { ...d.ui, inverted } } } as LhMessage;
	});
}

/** Anything the wake pipeline may queue and deliver — a native marker. */
export type SteerMessage = LhMarkerMessage;

/** Whether a result is the failure shape (html/svg empty, failure brief). */
export function isSubagentFailure(
	kind: JobKind,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): boolean {
	if (kind === "research") {
		const r = result as ResearchResult;
		return r.sources.length === 0 && /^Research failed:/i.test(r.brief);
	}
	if (kind === "demo") {
		const r = result as DemoResult;
		return typeof r.html !== "string" || r.html.length === 0;
	}
	if (kind === "pdf") {
		const r = result as PdfResult;
		return /^PDF failed:/i.test(r.brief);
	}
	const r = result as VisualResult;
	return typeof r.svg !== "string" || r.svg.length === 0;
}

/** The model-facing text of a steer: what the result IS, what to do with it. */
function steerText(kind: JobKind, result: ResearchResult | DemoResult | VisualResult | PdfResult): string {
	if (isSubagentFailure(kind, result)) {
		if (kind === "research")
			return `${(result as ResearchResult).brief}\n\nContinue with what you can establish and flag the uncertainty to the learner.`;
		if (kind === "demo")
			return `The demo "${(result as DemoResult).title}" could not be built: ${
				(result as DemoResult).notes ?? "unknown reason"
			}. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`;
		if (kind === "pdf")
			return `${(result as PdfResult).brief}\n\nContinue with what you can establish from the session and flag the gap to the learner.`;
		return `The figure could not be made: ${(result as VisualResult).notes ?? "unknown reason"}. Fall back to prose or mermaid, or re-call visual with a tighter brief.`;
	}
	if (kind === "research")
		return `Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n${(result as ResearchResult).brief}`;
	if (kind === "pdf")
		return `PDF reading complete — the reader's brief on "${(result as PdfResult).path}" follows, with page citations. Weave it into the lesson and cite pages when you use it:\n\n${(result as PdfResult).brief}`;
	if (kind === "demo")
		return `The demo "${(result as DemoResult).title}" is built, headlessly tested, and rendered in the lesson. Builder notes: ${
			(result as DemoResult).notes ?? "(none)"
		}.\nTeach with it — reference its controls by name and point the learner at what to try.`;
	return `The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: ${
		(result as VisualResult).notes ?? "(none)"
	}.\nReference its elements as you teach.`;
}

/**
 * Build the steer message for a finished job (pure — shared by the runner,
 * the wake pipeline, and tests). Deterministic id per job makes re-delivery
 * idempotent.
 */
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId" | "subscriptionGeneration">,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): SteerMessage {
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-steer",
		content: steerText(job.kind, result),
		display: true,
		details: {
			jobId: job.id,
			kind: job.kind,
			toolCallId: job.toolCallId,
			result,
			...(job.subscriptionGeneration ? { subscriptionGeneration: job.subscriptionGeneration } : {}),
		},
		timestamp: Date.now(),
	};
}

/** Build the abort steer for an aborted job (pure — shared by the
 * abort path in src/server/jobs.ts and tests). Same id space as the result
 * steer (same id space — exactly one delivers). */
export function buildAbortSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId" | "subscriptionGeneration">,
): SteerMessage {
	const meta = {
		jobId: job.id,
		kind: job.kind,
		toolCallId: job.toolCallId,
		aborted: true as const,
		...(job.subscriptionGeneration ? { subscriptionGeneration: job.subscriptionGeneration } : {}),
	};
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-abort",
		content: abortText(job.kind),
		display: true,
		details: meta,
		timestamp: Date.now(),
	};
}

/** What the teacher reads: one line telling it the result is not coming,
 * how to acknowledge, and that re-dispatching is allowed. */
function abortText(kind: JobKind): string {
	if (kind === "research")
		return "Research aborted — the learner aborted the research job, so no brief is coming. Acknowledge it in one line and continue teaching without it (or offer to re-dispatch it).";
	if (kind === "demo")
		return "The demo job was aborted by the learner — no demo is coming. Acknowledge it in one line and teach the topic in prose instead (a re-dispatch is fine if the learner wants it).";
	if (kind === "pdf")
		return "The PDF reading job was aborted by the learner — no brief is coming. Acknowledge it in one line and continue without it (a re-dispatch is fine if the learner wants it).";
	return "The figure job was aborted by the learner — no figure is coming. Acknowledge it in one line and teach without it (a re-dispatch is fine if the learner wants it).";
}

// ─── the probe handoff steer (the probe→teach split, docs/probe-teach-split.md §2) ──
//
// probe_done's execute queues this through the same wake pipeline; the
// pump fires it once the prober's turn ends (gates + grace). It carries no
// artifact — the assessment it references is durable in the transcript as
// the probe_done tool result. Deterministic id per chat: exactly one
// handoff, idempotent re-delivery. The marker's content is HANDOFF_TEXT
// (core/contracts/chat.ts — single source); the UI renders the quiet
// system line off the customType. Nothing human-looking is persisted, ever.

export function buildProbeHandoffSteer(chatId: string): SteerMessage {
	return newHandoffMessage(chatId);
}

/** True when the transcript already carries this steer — idempotent
 *  delivery for ANY steer kind: every steer id is deterministic per its
 *  event (steer_<jobId> for jobs, steer_probe_<chatId> for the handoff). */
export function steerDelivered(messages: LhMessage[], steerId: string): boolean {
	return messages.some((m) => m.id === steerId);
}


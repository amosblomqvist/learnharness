/**
 * THE WAKE PIPELINE (contracts.ts "THE ASYNC PROTOCOL" §4) — server-side
 * steer delivery for finished sub-agent jobs. Wave C (2026-09-26):
 * delivery rides pi's OWN follow-up queue when a run is live, and the
 * idle wake otherwise. One registry, two vehicles.
 *
 *   deliverJobResult(steer) — the runner calls this on job completion.
 *     The steer joins a per-chat serialized registry and the pump drives
 *     it along ONE of two paths:
 *
 *       1. LIVE RUN → pi steering: the marker is handed to the LIVE
 *          agent's steering queue (agent.steer). pi polls that queue at
 *          TURN BOUNDARIES — after a completed assistant message AND its
 *          tool results (never between a toolCall and its result), and
 *          again at the run's start (a continuation drains the queue
 *          BEFORE its first LLM call) — and CONTINUES THE SAME RUN: the
 *          marker joins the context mid-lesson, rides the live event
 *          stream (message_start/message_end), and lands in the record
 *          at that run's persist. This is the owner's 2026-09-26
 *          correction: a real lesson is one continuous teach→quiz→teach
 *          loop, so delivery must happen BETWEEN messages inside the
 *          run — waiting for the run to stop (follow-ups) only ever
 *          fires at a stopper exit, which is exactly when it must not.
 *          The question stopper runs BEFORE the post-turn poll and
 *          exits the loop, so a quiz-terminated run never injects: the
 *          handed marker strands (see settleSteers) and waits — the
 *          ANSWER run then picks it up at its start poll. probe-handoff
 *          markers NEVER take this path (owner ruling: the handoff must
 *          start the TEACHER's run — a record-level branch only a fresh
 *          wake can make).
 *       2. IDLE WAKE: no live turn. WAIT FOR IDLE (turn-liveness OR a
 *          dangling question — an unanswered client-side tool call breaks
 *          provider conversion), then fire ONE server-side wake turn
 *          carrying EVERY queued marker as its input appends (write-ahead
 *          persist, liveness, extraction — one code path, the same
 *          composition as a client request). A 409 means a client turn
 *          raced in — re-queue and retry with backoff. Idempotent per
 *          jobId (steerDelivered): a crashed wake or a duplicate deliver
 *          is skipped, not duplicated.
 *
 *   settleSteers(chatId, persisted) — the handler calls this at turn
 *     settlement (after unregisterLiveAgent): entries the run DELIVERED
 *     resolve + flip their jobs; entries that were handed to the dying
 *     run but never injected (stopper exit, abort, a missed final poll)
 *     return to pending and the pump restarts — no stranding, no loss.
 *
 *   Crash recovery (recoverStaleJobs): a process restart can orphan jobs —
 *     "running" with a result (the wake never fired) or without one (the
 *     sub-agent loop itself died). The sweep re-delivers finished results
 *     (idempotently) and re-spawns unfinished loops, both via injected
 *     seams. It runs lazily off the /api/jobs poll, throttled.
 *
 * All mutable state lives on globalThis (the turn-liveness lesson: Next dev
 * gives each route entry its own module instances — a module-level Map would
 * be a different object in each).
 */

import {
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type JobRecord,
	type SteerMessage,
} from "../core/contracts.ts";
import type { TurnInput } from "../core/input-events.ts";
import { danglingQuestionOf, endsInDismissal, type LhMessage } from "../core/native-messages.ts";
import { fireJobAbort, isJobLive } from "../agent/subagents/aborts.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import type { Agent } from "@earendil-works/pi-agent-core";

/** Fires one server-side teacher turn: (chatId, input) → HTTP-ish status.
 *  Wave C: the input is the IDLE WAKE — every queued marker as the turn's
 *  input appends (the handler appends them natively under the wake's own
 *  turn claim; one composition for every turn). */
export type TurnRunner = (chatId: string, input: TurnInput) => Promise<number>;

/** Re-runs a job's sub-agent loop (crash recovery for orphaned jobs). */
export type JobRespawn = (jobId: string) => void;

interface QueuedSteer {
	steer: SteerMessage;
	resolve: () => void;
	reject: (reason: Error) => void;
	/** The live agent this marker was steered into (agent.steer) — set by
	 *  the hand-off helper. Guards double-handoff (a re-pumped loop or a
	 *  re-registered run must not re-queue what a run already holds) and is
	 *  CLEARED at settlement for markers the dying run never injected. */
	handedTo?: Agent;
}

interface WakeState {
	turnRunner?: TurnRunner;
	respawn?: JobRespawn;
	/** chatId → steers awaiting delivery, in arrival order. The single
	 *  delivery registry (Wave C: the agent's own follow-up queue is a
	 *  per-run VEHICLE, not the registry — settlement reconciles here). */
	queues: Map<string, QueuedSteer[]>;
	/** chatId → user-steered messages awaiting drain (composer steering,
	 *  2026-10-03). Same deliver-or-requeue lifecycle as job markers: the
	 *  live agent's steering queue is the VEHICLE, this is the registry —
	 *  a steer stranded behind a question or an abort stays parked here
	 *  and rides the chat's NEXT run (handOffEligible). */
	userSteers: Map<string, UserSteerEntry[]>;
	/** chatId → the agent of the CURRENTLY streaming turn (cleared at
	 *  settlement, before settleSteers). The pump's live path hands
	 *  markers to this agent's follow-up queue. */
	liveAgents: Map<string, Agent>;
	/** Chats whose pump loop is currently active (serialization per chat). */
	pumping: Set<string>;
	/** Throttle bookkeeping for the stale-job sweep. */
	lastSweepAt: number;
}

interface LhWakeGlobal {
	__lhWakePipeline?: WakeState;
}

function state(): WakeState {
	const g = globalThis as typeof globalThis & LhWakeGlobal;
	return (g.__lhWakePipeline ??= { queues: new Map(), liveAgents: new Map(), userSteers: new Map(), pumping: new Set(), lastSweepAt: 0 });
}

/** chat-handler wires this at module init: its adapter around handleChatRequest. */
export function setTurnRunner(run: TurnRunner): void {
	state().turnRunner = run;
}

/** chat-handler wires this at module init: its job runner's runJob. */
export function setJobRespawn(respawn: JobRespawn): void {
	state().respawn = respawn;
}

const POLL_MS = 400;
/** After the gates open, wait a beat before firing — a client that just
 *  answered a question is about to send its continuation; don't 409 it.
 *
 *  Evidence for 750: the race window is exactly the learner's answer→POST
 *  flight — sendAutomaticallyWhen dispatches synchronously on addToolOutput,
 *  the answer hits the record only at the write-ahead persist, and beginTurn
 *  flips the turn registry immediately after, all before the grace can fire
 *  (measured localhost RTT ~10ms; typical LAN/production RTT <300ms). 750ms
 *  is 2.5× the worst realistic flight. A miss self-heals: the pump rechecks
 *  the gates after the grace AND the wake pipeline retries 409s with a
 *  backoff ramp — and since the transport's merge-retry (chat-transport.ts)
 *  made client 409s non-fatal, even a pathological RTT degrades gracefully.
 *  (Was 1500 — pure guess; 750 claws back 750ms of post-answer delivery
 *  latency without weakening the guard.) */
const GRACE_MS = 750;
/** 409 backoff: capped ramp so a busy client can't spin the pump. */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The job a steer belongs to, if it is a job steer (result/abort);
 *  probe-handoff steers have no job — null. */
function jobIdOf(steer: SteerMessage): string | null {
	const details = steer.details as { jobId?: string } | undefined;
	return typeof details?.jobId === "string" ? details.jobId : null;
}

/** Dock bookkeeping: the marker reached the learner's view — flip its job
 *  NOW instead of waiting for the delivering turn to settle. Called from
 *  BOTH visibility seams: the marker's message_end wire event (live steer
 *  injection — the card is on screen while the teacher keeps teaching) and
 *  the write-ahead persist in handleChatInput (the wake's input appends —
 *  the card is durable in the record). The registry's delivery promise
 *  still settles via settleSteers / the runner-200 path; finalizeJob is
 *  idempotent, so the later flip is a no-op. Owner ruling (2026-09-26): a
 *  delivered subagent leaves the background dock the moment its result is
 *  visible, not when the teacher's turn ends. */
export function noteSteerVisible(steer: SteerMessage): void {
	finalizeSteer(steer);
}

/** Finalize a delivered steer's job bookkeeping — job steers only. */
function finalizeSteer(steer: SteerMessage): void {
	const jobId = jobIdOf(steer);
	if (jobId) finalizeJob(jobId);
}

/** Fail a steer's job on unrecoverable delivery failure — job steers only. */
function failSteer(steer: SteerMessage, err: Error): void {
	const jobId = jobIdOf(steer);
	if (jobId) failJob(jobId, err);
}

/** Queue ANY steer (result, abort, probe handoff) through the pipeline.
 *  Resolves when the wake turn has completed; rejects when delivery fails
 *  unrecoverably. Never rejects for queueing itself. */
export function deliverJobResult(steer: SteerMessage): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const s = state();
		const chatId = chatIdOf(steer);
		const queue = s.queues.get(chatId) ?? [];
		queue.push({ steer, resolve, reject });
		s.queues.set(chatId, queue);
		void pump(chatId);
	});
}

/** Hand every eligible pending marker to a live agent's steering queue
 *  (idempotent per agent via handedTo). Called from BOTH the pump's live
 *  path and registerLiveAgent — a parked marker (stranded behind a quiz)
 *  must not wait for the pump loop to notice the new run: the handler
 *  registers the answer run's agent BEFORE runPiTurn, so this hand-off
 *  beats the loop's synchronous start-poll drain and the marker rides the
 *  run's FIRST LLM call (the native equivalent of the old continuation
 *  coalescing). */
function handOffEligible(chatId: string, agent: Agent): void {
	const queue = state().queues.get(chatId);
	if (queue && queue.length > 0) {
		for (const entry of queue) {
			if (entry.handedTo !== agent && entry.steer.customType !== "probe-handoff") {
				agent.steer(entry.steer);
				entry.handedTo = agent;
			}
		}
	}
	// User steers (2026-10-03): same hand-off, any live run — a steer
	// stranded behind a question or abort rides the chat's next run's
	// first boundary. No probe-handoff exclusion: these are learner
	// words, owed to whatever run is live.
	const userQueue = state().userSteers.get(chatId);
	if (userQueue && userQueue.length > 0) {
		for (const entry of userQueue) {
			if (entry.handedTo !== agent) {
				agent.steer(entry.message);
				entry.handedTo = agent;
			}
		}
	}
}

/** The chat-handler registers the CURRENTLY STREAMING turn's agent BEFORE
 *  runPiTurn (the loop's start steering-poll drains synchronously inside
 *  that call — a later registration would miss it). Pending registry
 *  markers are steered into the run right here. The settle seam cannot
 *  beat the registration: settlement needs a streamed response, which
 *  never happens inside the constructor call. */
export function registerLiveAgent(chatId: string, agent: Agent): void {
	state().liveAgents.set(chatId, agent);
	handOffEligible(chatId, agent);
}

/** A parked user steer: the message plus the agent it was last handed to
 *  (the double-handoff guard — a reconcile keeps it only when its id
 *  never landed in the persisted record). */
export interface UserSteerEntry {
	message: LhMessage;
	handedTo?: Agent;
}

/** The steer route's live hand-off (composer steering, 2026-10-03).
 *  Synchronous by design — no interleaving between the live-agent check
 *  and the queue() means a settling turn can never race the hand-off.
 *  Returns false when no turn is live: the caller 409s and the client
 *  falls back to a plain text send (the settle race). The registry copy
 *  is the stranding safety net: if this agent dies undelivered (question
 *  termination, abort), reconcileUserSteers keeps it parked for the
 *  chat's next run. */
export function steerLiveChat(chatId: string, message: LhMessage): boolean {
	const agent = state().liveAgents.get(chatId);
	if (!agent) return false;
	const entry: UserSteerEntry = { message };
	const q = state().userSteers.get(chatId) ?? [];
	q.push(entry);
	state().userSteers.set(chatId, q);
	agent.steer(message);
	entry.handedTo = agent;
	return true;
}

/** TURN SETTLEMENT RECONCILIATION for user steers: delivered ids drop
 *  (the record holds them); undelivered stay parked for the next run.
 *  Memory-only by design (same tradeoff as job markers): a server
 *  restart drops parked steers — and the whole turn dies with it anyway. */
export function reconcileUserSteers(chatId: string, persisted: readonly LhMessage[]): void {
	const q = state().userSteers.get(chatId);
	if (!q || q.length === 0) return;
	const ids = new Set(persisted.map((m) => (m as { id?: string }).id));
	const kept = q.filter((e) => !ids.has(e.message.id));
	if (kept.length === 0) state().userSteers.delete(chatId);
	else state().userSteers.set(chatId, kept);
}

/** Clear the live agent at settlement — MUST run before settleSteers so the
 *  reconciliation's re-pump can never hand a marker to the dying agent. */
export function unregisterLiveAgent(chatId: string): void {
	state().liveAgents.delete(chatId);
}

/** TURN SETTLEMENT RECONCILIATION (Wave C): the handler calls this AFTER
 * unregisterLiveAgent, with the run's persisted messages. Two jobs:
 *
 *   - entries whose marker the run DELIVERED (in-run follow-up injection —
 *     their ids are in the persisted slice) resolve and flip their jobs;
 *   - entries handed to the dying run but never injected (the question
 *     stopper exited before the follow-up poll; an abort; a delivery that
 *     raced the final poll) return to PENDING (handedTo cleared) and the
 *     pump restarts — the idle wake delivers them once the gates open.
 *
 * This is what makes the live hand-off safe: pi owns no retry for a marker
 * stranded in a settled agent's queue, so the registry stays the truth and
 * the dead agent's copy is simply abandoned (GC'd with the agent). */
export function settleSteers(chatId: string, persisted: { id?: string }[]): void {
	const queue = state().queues.get(chatId);
	if (!queue || queue.length === 0) return;
	const deliveredIds = new Set(persisted.map((m) => m.id).filter(Boolean));
	const remaining: QueuedSteer[] = [];
	for (const entry of queue) {
		if (deliveredIds.has(entry.steer.id)) {
			finalizeSteer(entry.steer);
			entry.resolve();
		} else {
			entry.handedTo = undefined;
			remaining.push(entry);
		}
	}
	if (remaining.length === 0) state().queues.delete(chatId);
	else {
		state().queues.set(chatId, remaining);
		void pump(chatId);
	}
}

/** Result of an abort attempt — the endpoint maps these to HTTP. */
export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

/**
 * ABORT (2026-09 dock semantics, user-decided): real kill, error with
 * reason, the teacher still learns. The dock's END button reaches this
 * through POST /api/activity/abort (body {kind: "job", id: jobId}); the
 * route is master's thin composition — this is the job-side mechanism.
 * Four things happen, in order:
 *
 *   1. KILL the spend: fire the job's registered AbortController (the
 *      runner registered it at loop start) — the in-flight model call
 *      aborts, not just the next loop check. The runner unwinds silently
 *      (its catch checks abortSignal.aborted; finishJob checks status).
 *   2. DROP any queued result steer for this job (the delivering-result
 *      phase): resolve its entry without firing the wake. If the wake
 *      turn is ALREADY in flight (the pump shifted the entry), it's too
 *      late — the result steer lands, and the cancellation steer dedupes
 *      against it via steerDelivered (same jobId metadata).
 *   3. FLIP the record to error "Aborted by learner" immediately — the
 *      poll reflects the user's action at once (the user chose
 *      error-with-reason over a distinct cancelled status). finalizeJob
 *      never overwrites a non-running status, so the flip is terminal no
 *      matter what the wake does.
 *   4. STEER the teacher: a one-line abort note (buildAbortSteer) through
 *      the same wake pipeline, so the teacher's promise of a result
 *      doesn't hang silently in the lesson.
 *
 * The runner writes the usage folded so far in its finally (merge patch),
 * so an aborted job's money record survives the kill.
 */
export function abortJob(jobId: string): AbortOutcome {
	const job = stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running") return { ok: false, reason: "not_running" };

	fireJobAbort(jobId); // no-op when the loop already returned (delivering)

	// Drop any queued steers for this job (their deliver() resolves unfired).
	// HANDED entries (already in a live run's follow-up queue) are past
	// recall — same ruling as a fired wake: the result lands, and the abort
	// note below dedupes against it via steerDelivered (same jobId).
	const queue = state().queues.get(job.chatId);
	if (queue) {
		const remaining = queue.filter(
			(e) => jobIdOf(e.steer) !== jobId || e.handedTo !== undefined,
		);
		if (remaining.length === 0) state().queues.delete(job.chatId);
		else state().queues.set(job.chatId, remaining);
		for (const entry of queue) {
			if (jobIdOf(entry.steer) === jobId && entry.handedTo === undefined) entry.resolve();
		}
	}

	stores.jobStore.updateJob(jobId, { status: "error", error: "Aborted by learner", activity: "aborted" });
	void deliverJobResult(buildAbortSteer(job)).catch(() => {
		/* deliverJobResult marks the job error on unrecoverable failure */
	});
	return { ok: true };
}

function chatIdOf(steer: SteerMessage): string {
	// The probe handoff carries its chat directly in the marker details (the
	// job record would say it too, but the details are the cheap path).
	if (steer.customType === "probe-handoff") {
		return (steer.details as { chatId: string }).chatId;
	}
	// The chat is resolvable from the job record; the steer's details
	// carry jobId, which indexes the store.
	const jobId = jobIdOf(steer);
	const job = jobId ? stores.jobStore.getJob(jobId) : undefined;
	return job?.chatId ?? "";
}

/**
 * The per-chat pump: delivers the registry along pi's two native paths.
 * Only one loop per chat at a time; later arrivals ride the registry.
 *
 * Each iteration first clears dead weight (gone chat, already-delivered
 * markers), then picks the vehicle: a LIVE turn takes every eligible
 * marker via agent.followUp (the run continues at its own stop — nothing
 * more to do here until settlement re-pumps); otherwise the IDLE WAKE
 * fires ONE turn carrying every pending marker as its input appends.
 */
async function pump(chatId: string): Promise<void> {
	if (!chatId) return;
	const s = state();
	if (s.pumping.has(chatId)) return;
	s.pumping.add(chatId);
	try {
		for (let attempt = 0; ; ) {
			const queue = s.queues.get(chatId);
			if (!queue || queue.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			// Gone chat: nothing to deliver into.
			const record = stores.chatStore.getChat(chatId);
			if (!record) {
				s.queues.delete(chatId);
				for (const entry of queue) {
					entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${entry.steer.id}`));
				}
				continue;
			}

			// Idempotent delivery: the transcript already carries these steers
			// (an in-run injection persisted, a wake completed, or a duplicate
			// deliver raced in). Resolve and flip without re-firing anything.
			const stillPending = queue.filter((e) => !steerDelivered(record.messages, e.steer.id));
			for (const entry of queue) {
				if (!stillPending.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (stillPending.length === 0) {
				s.queues.delete(chatId);
				return;
			}
			s.queues.set(chatId, stillPending);

			// VEHICLE 1 — THE LIVE RUN: pi's steering queue. The agent of the
			// streaming turn takes every eligible marker; pi injects at the
			// next turn boundary (message_start/message_end on the live wire,
			// between completed assistant+toolResult units) and continues the
			// run. Delivery resolves at settlement (settleSteers). Nothing else
			// to do in this loop iteration — the turn owns the delivery.
			const live = s.liveAgents.get(chatId);
			if (live && isTurnRunning(chatId)) {
				handOffEligible(chatId, live);
				const handable = stillPending.filter((e) => e.handedTo === live);
				// probe-handoffs never ride a live run (owner ruling: the
				// handoff must START the teacher's run) — if any remain
				// pending, wait the run out and loop to the wake below.
				const handoffWaits = stillPending.some(
					(e) => e.steer.customType === "probe-handoff",
				);
				if (handable.length > 0 && !handoffWaits) {
					return; // the run delivers; settleSteers re-pumps the rest
				}
				if (handable.length > 0) {
					await delay(POLL_MS);
					await waitForIdle(chatId);
					continue;
				}
			}

			// VEHICLE 2 — THE IDLE WAKE: one server-side turn carrying EVERY
			// pending marker as its input appends (the handler write-ahead
			// persists them under the wake's own turn claim).
			await waitForIdle(chatId);

			// Re-fetch AFTER the gates open — waitForIdle can wait out a quiz
			// answer (minutes), and sending the pre-wait snapshot would clobber
			// the client's answer + continuation in the write-ahead persist.
			const fresh = stores.chatStore.getChat(chatId);
			if (!fresh) {
				continue; // the gone-chat branch rejects next iteration
			}

			// The runner is required — chat-handler sets it at init. If some
			// module instance missed the wiring, fail loudly rather than hang.
			if (!s.turnRunner) {
				s.queues.delete(chatId);
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				for (const entry of stillPending) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
				return;
			}

			// A live run may have delivered some markers while the gates were
			// closed — re-check: only still-missing markers ride the wake.
			const fire = stillPending.filter((e) => !steerDelivered(fresh.messages, e.steer.id));
			for (const entry of stillPending) {
				if (!fire.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (fire.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			// THE DISMISSAL PAUSE (owner design 2026-10-03, "A2"): the record
			// ends in a user dismissal — the session waits for the USER. Hold
			// every marker in the queue (no wake fires) and return; the user's
			// next send is the wake that carries them (the in-run vehicle below
			// hands them to that turn once the text-claim lands — until then,
			// settlement re-pumps and lands them right after it). The pause is
			// derived from the tail, so any user message un-holds by construction.
			if (endsInDismissal(fresh.messages)) {
				return;
			}

			// DEQUEUE-AT-FIRE (the Wave C lesson from the Wave B regression):
			// the carried markers leave the registry BEFORE the turn runs —
			// the wake run's OWN follow-up poll must never see its own cargo,
			// and a 409 (client raced in) must be able to push them back.
			s.queues.delete(chatId);
			const steers = fire.map((e) => e.steer);

			// Fire the wake (every marker as the turn's input appends). A 409 =
			// a client turn raced in between idle and firing — push the cargo
			// back and retry after backoff (the racing turn's own settlement
			// re-pumps if it beats us to the re-queue).
			const status = await s.turnRunner(chatId, { type: "steers", steers }).catch((err: unknown) => {
				console.error(`[steer ${steers.map((x) => x.id).join(",")}] wake turn crashed:`, err);
				return -1;
			});
			if (status === 409) {
				const back = s.queues.get(chatId) ?? [];
				back.push(...fire);
				s.queues.set(chatId, back);
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;

			if (status === 200) {
				for (const entry of fire) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			} else {
				const err = new Error(`wake turn failed with status ${status}`);
				for (const entry of fire) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
			}
		}
	} finally {
		s.pumping.delete(chatId);
		// A steer may have arrived between the last check and the finally —
		// restart the pump rather than strand it. Entries already handed to
		// a live run are NOT stragglers (settleSteers owns their resurrection)
		// — restarting for them would just park in waitForIdle forever.
		const q = state().queues.get(chatId) ?? [];
		if (q.some((e) => e.handedTo === undefined)) void pump(chatId);
	}
}

/** Flip the job to its final status now that the lesson has resumed. */
function finalizeJob(jobId: string): void {
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	const result = job.result;
	const failed = result ? isSubagentFailure(job.kind, result as never) : true;
	stores.jobStore.updateJob(jobId, {
		status: failed ? "error" : "done",
		activity: failed ? "failed" : "delivered",
	});
}

function failJob(jobId: string, err: Error): void {
	// An aborted job stays aborted even when its (abort) steer
	// delivery fails — the user's action is the terminal fact, not the
	// delivery error. Non-running records are never overwritten here.
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	stores.jobStore.updateJob(jobId, { status: "error", error: err.message, activity: "delivery failed" });
}

/**
 * Wait until the chat can take a wake turn: no turn in flight AND no
 * unanswered question call (the record's dangling question — the answer
 * arrives as its tool result, and no turn may run in the window). Poll;
 * the learner may take arbitrarily long to answer, and that is correct —
 * the steer fires right after their answer turn completes.
 */
async function waitForIdle(chatId: string): Promise<void> {
	for (;;) {
		const record = stores.chatStore.getChat(chatId);
		if (!record) return;
		const blocked = isTurnRunning(chatId) || danglingQuestionOf(record.messages) !== null;
		if (!blocked) {
			await delay(GRACE_MS);
			const recheck = stores.chatStore.getChat(chatId);
			if (
				!isTurnRunning(chatId) &&
				recheck &&
				danglingQuestionOf(recheck.messages) === null
			) {
				return;
			}
		}
		await delay(POLL_MS);
	}
}

// ─── crash recovery ──────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 30_000;

/**
 * Lazy sweep (called off the /api/jobs poll, throttled), LIVENESS-GATED
 * (accuracy wave, 2026-09-19): a "running" record without a live loop
 * registration (subagents/aborts.ts) is an orphan of a process death —
 * re-deliver its stored result (idempotently) or re-spawn the loop, at
 * once (the old 15-minute age heuristic waited on ghosts AND re-ran
 * hung-but-alive loops beside themselves — the figure-maker incident,
 * 2026-09-18). A record WITH a live registration is provably executing
 * in THIS process — never touched, however old: a hung first model call
 * (zero usage ever billed) stays honestly "running" in the dock until
 * END kills it. The abort registration spans loop start to delivery
 * completion, so a live registration can never belong to a dead run.
 */
/** Re-run a job's sub-agent loop — exposed for the sweep's tests (the
 *  /api/jobs poll is its only production caller, disabled under NODE_ENV=test). */
export function recoverStaleJobs(): void {
	const s = state();
	const now = Date.now();
	if (now - s.lastSweepAt < SWEEP_THROTTLE_MS) return;
	s.lastSweepAt = now;
	try {
		for (const chat of stores.chatStore.listChats()) {
			for (const job of stores.jobStore.listJobs(chat.id)) {
				if (job.status !== "running") continue;
				if (isJobLive(job.id)) continue; // provably executing here — never re-run beside it
				if (!stores.chatStore.getChat(job.chatId)) continue;
				if (isTurnRunning(job.chatId)) continue; // a wake turn may be delivering it right now
				if (job.result) {
					// The wake never fired (or crashed mid-flight): re-deliver.
					const steer = buildSubagentSteer(job, job.result as never);
					void deliverJobResult(steer).catch(() => {
						/* deliverJobResult marks the job error on failure */
					});
				} else {
					// The sub-agent loop itself died with the process: re-spawn.
					if (!s.respawn) continue;
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-running" });
					s.respawn(job.id);
				}
			}
		}
	} catch (err) {
		console.error("[jobs] stale-job recovery sweep failed:", err);
	}
}

/** The /api/jobs entry: job list for the client poll (+ lazy recovery). */
export function listJobs(chatId: string): JobRecord[] {
	if (process.env.NODE_ENV !== "test") recoverStaleJobs();
	return stores.jobStore.listJobs(chatId);
}

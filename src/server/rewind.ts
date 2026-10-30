/**
 * Rewind a chat's tail — editing the last sent message (issue #321). The
 * learner's last message and everything after it is removed as if it never
 * happened; everything before it stays intact. The caller then resends the
 * edited text through the normal send.
 *
 * "As if it never happened" means undoing what the tail left behind:
 *   - the transcript itself, and the plan tree it implied (restored from
 *     the last plan_init the retained messages still hold);
 *   - the graph the tail's extraction wrote (core/graph-deletion.ts
 *     deleteMessageTraces);
 *   - the background jobs the tail spawned (killed WITHOUT the abort steer
 *     abortJob would queue — it would land on a call that no longer exists)
 *     and their queued deliveries;
 *   - the learner steers still parked for the chat;
 *   - and the other way round: a KEPT job whose result (or abort) marker sat
 *     inside the tail owes that delivery again.
 * The usage logs stay: that spend really happened.
 *
 * Choreography (the deleteChatSession precedent):
 *   1. validate the target — the chat's LAST user message — and refuse a
 *      compaction in flight BEFORE touching anything;
 *   2. stop the running turn and wait for it to settle (its onFinish
 *      persists the partial transcript and may kick an extraction);
 *   3. claim the chat's turn slot, so no wake turn can start mid-rewind;
 *   4. wind the extraction down — nothing may merge while the ledgers are
 *      rewritten;
 *   5. ONE synchronous block: graph ledgers → jobs → the chat record LAST.
 *      A crash mid-block leaves a record that still holds the tail while the
 *      rest is already undone; every step is idempotent, so the retry
 *      finishes the job.
 */

import { fireJobAbort, isJobLive } from "../agent/subagents/aborts.ts";
import { coverageSlots } from "../core/coverage.ts";
import { emit } from "../core/events.ts";
import { deleteMessageTraces, type MessageDeletionStats } from "../core/graph-deletion.ts";
import { userFacingTextOf, type LhMessage } from "../core/native-messages.ts";
import { latestPlanTreeOf } from "../core/plan-blocks.ts";
import { windDownExtraction } from "./chats.ts";
import { compactionInFlight } from "./compaction.ts";
import { graphRevision } from "./graph.ts";
import { discardRewoundDeliveries } from "./jobs.ts";
import { stores } from "./stores.ts";
import { beginTurn, endTurn, isTurnRunning } from "./turn-liveness.ts";
import { abortTurn, runningTurn } from "./turn-runs.ts";

/** What the rewind did — the route maps it straight to HTTP. */
export type RewindOutcome =
	| { ok: false; status: 404; code: "not_found" | "message_not_found"; error: string }
	| { ok: false; status: 409; code: "not_last_user_message"; error: string; lastUserMessageId: string | null }
	| { ok: false; status: 409; code: "compaction_running" | "turn_in_flight"; error: string }
	| { ok: false; status: 503; code: "turn_winding_down" | "extraction_winding_down"; error: string }
	| {
			ok: true;
			/** The removed message's text — what goes back to the composer. */
			text: string;
			removedMessages: number;
			stats: MessageDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/** How long an aborted turn may take to settle before the caller gets a
 *  retryable 503 (a wedged provider must never wedge the rewind). Mutable
 *  so tests can tighten it. */
export const rewindLimits = { settleTimeoutMs: 10_000 };
const SETTLE_POLL_MS = 50;

function compactionRunning(): Extract<RewindOutcome, { ok: false }> {
	return { ok: false, status: 409, code: "compaction_running", error: "The session is being compacted — try again when it finishes" };
}

function turnBusy(chatId: string): boolean {
	return isTurnRunning(chatId) || runningTurn(chatId) !== undefined;
}

async function turnSettled(chatId: string): Promise<boolean> {
	const deadline = Date.now() + rewindLimits.settleTimeoutMs;
	while (turnBusy(chatId)) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
	}
	return true;
}

function lastUserIndex(messages: readonly LhMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return i;
	return -1;
}

/** The target's index, or the failure that refuses it. */
function targetIndex(messages: readonly LhMessage[], messageId: string): number | Extract<RewindOutcome, { ok: false }> {
	const index = messages.findIndex((m) => m.id === messageId);
	if (index === -1) {
		return { ok: false, status: 404, code: "message_not_found", error: "No such message in this session" };
	}
	const last = lastUserIndex(messages);
	if (messages[index]!.role !== "user" || index !== last) {
		return {
			ok: false,
			status: 409,
			code: "not_last_user_message",
			error: "Only the last message you sent can be edited",
			lastUserMessageId: last === -1 ? null : messages[last]!.id,
		};
	}
	return index;
}

/** The jobs whose delivery marker (a result or abort steer) sits in these messages. */
function deliveryJobIdsOf(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "custom") continue;
		if (message.customType !== "subagent-steer" && message.customType !== "subagent-abort") continue;
		const jobId = (message.details as { jobId?: unknown } | undefined)?.jobId;
		if (typeof jobId === "string") ids.add(jobId);
	}
	return ids;
}

/** Every tool call the discarded messages made — what ties a job to the tail. */
function toolCallIdsOf(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
	}
	return ids;
}

export async function rewindChat(chatId: string, messageId: string): Promise<RewindOutcome> {
	const first = stores.chatStore.getChat(chatId);
	if (!first) return { ok: false, status: 404, code: "not_found", error: "No such session" };
	const refused = targetIndex(first.messages, messageId);
	if (typeof refused !== "number") return refused;

	// Refuse BEFORE the destructive abort: a refused rewind must not cost the
	// learner the reply that is still streaming.
	if (compactionInFlight(chatId)) return compactionRunning();

	// Stop the running turn, then claim the slot (steps 2 and 3). No await
	// sits between the settle check and the claim, so nothing can start a
	// turn in between.
	if (turnBusy(chatId)) {
		abortTurn(chatId);
		if (!(await turnSettled(chatId))) {
			return { ok: false, status: 503, code: "turn_winding_down", error: "The session's turn is still winding down — try again in a moment" };
		}
	}
	if (!beginTurn(chatId)) {
		return { ok: false, status: 409, code: "turn_in_flight", error: "A turn is running in this session — try again in a moment" };
	}

	try {
		// A compaction can start after the settle (the finished turn kicks it).
		if (compactionInFlight(chatId)) {
			return compactionRunning();
		}
		if (!(await windDownExtraction(chatId))) {
			return { ok: false, status: 503, code: "extraction_winding_down", error: "The session's extraction is still winding down — try again in a moment" };
		}

		// THE SYNC BLOCK — no awaits below. Re-read: the aborted turn
		// persisted its partial transcript after the first look.
		const record = stores.chatStore.getChat(chatId);
		if (!record) return { ok: false, status: 404, code: "not_found", error: "No such session" };
		const index = targetIndex(record.messages, messageId);
		if (typeof index !== "number") return index;
		const target = record.messages[index]!;
		const retained = record.messages.slice(0, index);
		const discarded = record.messages.slice(index);
		const discardedIds = new Set(discarded.map((m) => m.id));

		// Only slots with a view (tokens > 0) can hold a coverage row: every
		// view-less message of a role shares one fingerprint, so passing them
		// would match nothing real and invite a collision.
		const fingerprints = new Set(
			coverageSlots(record.messages)
				.filter((slot) => discardedIds.has(slot.message.id) && slot.tokens > 0)
				.map((slot) => slot.fp),
		);
		const stats = deleteMessageTraces(stores.graphStore, chatId, { messageIds: discardedIds, fingerprints });

		const toolCallIds = toolCallIdsOf(discarded);
		const jobs = stores.jobStore.listJobs(chatId).filter((job) => toolCallIds.has(job.toolCallId));
		for (const job of jobs) if (isJobLive(job.id)) fireJobAbort(job.id);
		discardRewoundDeliveries(chatId, new Set(jobs.map((job) => job.id)));
		let jobsRemoved = 0;
		for (const job of jobs) if (stores.jobStore.deleteJob(job.id)) jobsRemoved++;

		// A KEPT job whose delivery marker sat inside the tail loses that marker
		// with it: it owes the delivery again. Only a pending job is re-queued
		// (restorePendingDeliveries), so a stale "delivered" would lose its
		// result for good.
		const redeliver = deliveryJobIdsOf(discarded);
		for (const job of stores.jobStore.listJobs(chatId)) {
			if (redeliver.has(job.id) && job.delivery?.status === "delivered") {
				stores.jobStore.updateJob(job.id, { delivery: { ...job.delivery, status: "pending" } });
			}
		}

		stores.chatStore.rewindMessages(chatId, retained, latestPlanTreeOf(retained));
		emit("record-changed", { chatId });
		return {
			ok: true,
			text: userFacingTextOf((target as { content: unknown }).content).join("\n\n"),
			removedMessages: discarded.length,
			stats,
			jobsRemoved,
			graphRevision: graphRevision(),
		};
	} finally {
		endTurn(chatId);
	}
}

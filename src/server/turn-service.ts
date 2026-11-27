/**
 * The chat-turn services — one named seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
 *   persistTurn        — the canonical state write (Wave B: native history;
 *                        id stamping, placeholder filtering, plan-block
 *                        emission, abort-partial persistence)
 *   triggerExtraction  — the graph write channel: fires the extraction
 *                        pipeline (the sole graph writer) once a chat
 *                        crosses the token-budget threshold.
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatRecord, CoverageEntry, PlanTree } from "../core/contracts.ts";
import { derivePlanStatusesLh } from "../core/contracts.ts";
import type { EmissionStats } from "../core/graph.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { hasUnresolvedQuestion, newMessageId } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { planBlocksFor } from "../core/plan-blocks.ts";
import { readPluginQuestionCancellation } from "../core/plugin-questions.ts";
import { coverageOf } from "../core/coverage.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { ExtractionPipeline } from "../agent/subagents/extraction.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";

/** Distinguish a failed canonical save from later bookkeeping failures. */
export class TurnPersistenceError extends Error {
	constructor(cause: unknown) {
		super("The reply could not be saved.", { cause });
		this.name = "TurnPersistenceError";
	}
}

/**
 * The canonical state write (Wave B, owner-approved 2026-09-26): append the
 * turn's own messages — the agent loop's native history, provider/model/
 * usage/thinkingSignature stamped by pi itself. Persists even when aborted
 * — the partial transcript (including a pending question's unanswered
 * call) is what makes resume work.
 *
 * - Id stamping: pi messages carry no id; the record's identity needs one
 *   per message (client keys, append-only adoption, the continuation
 *   seam). Minted here, at the single canonical write.
 * - Placeholder filtering: a cleanly-posed question's synthetic
 *   "question posed" result is an in-memory loop device (Wave A's
 *   terminate) — NEVER persisted (fork 1: the record ends at the
 *   unanswered call; the learner's answer arrives as the real tool
 *   result). Errored question calls DO persist — the model's retry
 *   context.
 * - Plan blocks: one frozen snapshot per successful plan_init call,
 *   idempotent (persist replays are safe).
 *
 * Returns the stamped new messages (usage provenance reads them). Throws
 * TurnPersistenceError on failure so the runner can report it before DONE.
 */
export function persistTurn(
	chatStore: ChatStore,
	chatId: string,
	baseCount: number,
	turnMessages: readonly AgentMessage[],
	isAborted: boolean,
): LhMessage[] {
	try {
		const record = chatStore.getChat(chatId);
		if (!record) throw new Error(`Chat not found: ${chatId}`);
		const stamped: LhMessage[] = [];
		for (const m of turnMessages.slice(baseCount)) {
			const message = m as LhMessage;
			// The placeholder question result: loop device, never a record fact.
			if (
				(message as { role?: string }).role === "toolResult" &&
				(QUESTION_TOOLS as readonly string[]).includes((message as ToolResultMessage).toolName) &&
				!(message as ToolResultMessage).isError
			) {
				continue;
			}
			stamped.push(message.id ? message : ({ ...message, id: newMessageId() } as LhMessage));
		}
		const tree = record.tree;
		const blocks = planBlocksFor(record.messages, stamped, tree, [
			...record.messages,
			...stamped,
		]);
		chatStore.saveMessages(chatId, [...record.messages, ...stamped, ...blocks]);
		return stamped;
	} catch (err) {
		console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
		throw new TurnPersistenceError(err);
	}
}

/**
 * The graph write channel (vision §1 construction): the extraction pipeline
 * (extractor → auditor → merger — the sole graph writer) runs ASYNC once a
 * chat's UNCOVERED transcript tokens reach the chunk budget
 * (vision-extraction-coverage.md, 2026-09-15). Coverage reads through the
 * projection (the record is native history; the extraction view stays
 * client-shaped until Wave D). Fire-and-forget — never blocks the turn;
 * failures are logged by the pipeline and leave coverage untouched, so the
 * next trigger (or the manual extract button) re-runs what's left.
 *
 * Deliberately isolated in this one seam — the pipeline is
 * trigger-agnostic. Skipped under tests: scripted chats are fixtures, not
 * knowledge (the pipeline itself is tested directly with mock models).
 */
export interface ExtractionTriggerContext {
	previousMessages: readonly LhMessage[];
	previousTree: PlanTree | null | undefined;
	isAborted?: boolean;
}

function isQuestionToolResult(message: LhMessage): boolean {
	if (message.role !== "toolResult" || message.isError) return false;
	if ((QUESTION_TOOLS as readonly string[]).includes(message.toolName)) return true;
	if (message.lhQuestionOccurrence !== undefined) return true;
	return readPluginQuestionCancellation(message.details) !== null;
}

function isSuccessfulPlanInitResult(message: LhMessage): boolean {
	return (
		message.role === "toolResult" &&
		message.toolName === "plan_init" &&
		!message.isError &&
		(message.details as { ok?: unknown } | undefined)?.ok === true
	);
}

/** True when a non-empty plan tree has every node visited or current and no
 *  unresolved question remains open. Does NOT require a clean wrap-up assistant
 *  message after the final question result. */
export function areAllPlanNodesAnswered(
	tree: PlanTree | null | undefined,
	messages: readonly LhMessage[],
): boolean {
	if (!tree || tree.nodes.length === 0) return false;
	if (hasUnresolvedQuestion(messages)) return false;
	const statuses = derivePlanStatusesLh(tree, messages);
	return tree.nodes.every((n) => statuses.visited.has(n.id) || statuses.current === n.id);
}

/** True when all plan nodes are answered AND at least one error-free assistant
 *  message follows the last question result (or last plan_init event when no
 *  question result exists). Ensures failed closing turns or silent dismissals
 *  stay incomplete until a clean wrap-up/Retry lands. */
export function isPlanArcComplete(
	tree: PlanTree | null | undefined,
	messages: readonly LhMessage[],
): boolean {
	if (!areAllPlanNodesAnswered(tree, messages)) return false;
	let anchorIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isQuestionToolResult(messages[i]!)) {
			anchorIdx = i;
			break;
		}
	}
	if (anchorIdx === -1) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (isSuccessfulPlanInitResult(messages[i]!)) {
				anchorIdx = i;
				break;
			}
		}
	}
	for (let i = anchorIdx + 1; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			return true;
		}
	}
	return false;
}

function firstPlanInitAssistantIndex(messages: readonly LhMessage[], startIndex: number): number {
	for (let i = startIndex; i < messages.length; i++) {
		const m = messages[i]!;
		if (!isSuccessfulPlanInitResult(m)) continue;
		const callId = (m as ToolResultMessage).toolCallId;
		for (let j = i - 1; j >= startIndex; j--) {
			const candidate = messages[j]!;
			if (candidate.role !== "assistant") continue;
			if (candidate.content.some((b) => b.type === "toolCall" && b.id === callId)) {
				return j;
			}
		}
	}
	return -1;
}

/** True when this turn cleanly completed a learning arc (either finishing the
 *  previous plan before calling plan_init for a new arc, or completing the
 *  current plan arc). Refuses aborted/errored/assistant-less turns and avoids
 *  penny-batching turns after an arc was already complete. */
export function didCompleteLearningArc(
	currentTree: PlanTree | null | undefined,
	currentMessages: readonly LhMessage[],
	context?: ExtractionTriggerContext,
): boolean {
	if (!context || context.isAborted) return false;
	const startIdx = context.previousMessages.length;
	const turnSlice = currentMessages.slice(startIdx);
	let assistantCount = 0;
	for (const m of turnSlice) {
		if (m.role !== "assistant") continue;
		if (m.stopReason === "error" || m.stopReason === "aborted") return false;
		assistantCount++;
	}
	if (assistantCount === 0) return false;
	if (isPlanArcComplete(context.previousTree, context.previousMessages)) return false;
	const planInitMsgIdx = firstPlanInitAssistantIndex(currentMessages, startIdx);
	const prevCompletedBeforePlanInit =
		planInitMsgIdx !== -1 &&
		areAllPlanNodesAnswered(context.previousTree, currentMessages.slice(0, planInitMsgIdx));
	return prevCompletedBeforePlanInit || isPlanArcComplete(currentTree, currentMessages);
}

/** Decide whether a chat turn should kick off background extraction: either
 *  uncovered tokens reached the chunk budget OR a learning arc just completed
 *  with at least some uncovered prose. */
export function shouldTriggerExtraction(
	record: Pick<ChatRecord, "id" | "messages" | "tree">,
	coverageEntries: readonly CoverageEntry[],
	chunkTokens: number,
	context?: ExtractionTriggerContext,
): boolean {
	const covered = coverageOf(record.messages, coverageEntries, record.id);
	if (covered.uncoveredCount === 0 || covered.uncoveredTokens === 0) return false;
	if (covered.uncoveredTokens >= chunkTokens) return true;
	return didCompleteLearningArc(record.tree, record.messages, context);
}

/** Execute the extraction trigger check + fire without the NODE_ENV=test guard
 *  (direct test seam). Returns the pipeline promise when fired, or null. */
export function runExtractionTrigger(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
	chunkTokens: number,
	context?: ExtractionTriggerContext,
): Promise<EmissionStats> | null {
	try {
		const record = deps.chatStore.getChat(chatId);
		if (!record) return null;
		const entries = deps.graphStore.readCoverage();
		if (!shouldTriggerExtraction(record, entries, chunkTokens, context)) return null;
		return extraction.runExtraction(chatId).catch((err) => {
			// BYOK (owner, 2026-09-22) + key presence (provider-key interlude,
			// 2026-09-25): an unconfigured OR keyless write channel SKIPS (the
			// coverage ledger keeps the messages uncovered — the next trigger
			// retries once slots/keys are set); only real failures log.
			if (err instanceof ModelsNotConfiguredError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (missing: ${err.envelope.missing.join(", ")})`);
				return { nodes: 0, chains: 0 };
			}
			if (err instanceof ProviderKeyMissingError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (provider: ${err.envelope.provider})`);
				return { nodes: 0, chains: 0 };
			}
			console.error(`[chat ${chatId}] extraction pipeline failed:`, err);
			return { nodes: 0, chains: 0 };
		});
	} catch (err) {
		console.error(`[chat ${chatId}] extraction trigger failed:`, err);
		return null;
	}
}

export function triggerExtraction(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
	chunkTokens: number,
	context?: ExtractionTriggerContext,
): void {
	if (process.env.NODE_ENV === "test") return;
	void runExtractionTrigger(deps, extraction, chatId, chunkTokens, context);
}

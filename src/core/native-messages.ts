/**
 * THE NATIVE MESSAGE RECORD (Wave B, owner-approved 2026-09-26): chat
 * records store pi's own message shapes — the exact history the agent
 * loop builds — instead of AI-SDK UIMessages. Provider, model, usage,
 * stopReason, and thinking signatures are stamped by pi itself; replay is
 * `state.messages = record.messages` + `continue()` — the record IS the
 * agent state.
 *
 * WHY pi MESSAGES LACK OUR `id`: pi's session format gives every ENTRY an
 * id, never the message. This app needs a per-message id for client
 * identity (React keys, append-only adoption, the continuation seam), so
 * every record message carries ONE extra field — `id` — alongside the
 * native shape. `toLlmMessages` strips it at the wire: the provider never
 * sees it (verified single site, below).
 *
 * UI-ONLY CONTENT (owner ruling, fork 1 + the plan's custom-message
 * taxonomy): the probe→teach handoff, sub-agent steers,
 * and plan blocks are LhMarkerMessage — this app's declaration-merged
 * member of pi-agent-core's CustomAgentMessages extension point, shaped
 * exactly like pi's own CustomMessage ({role:"custom", customType,
 * content, display, details}). ONE seam — toLlmMessages, wired as the
 * agent's convertToLlm — owns every model-facing decision: markers
 * flatten to their canonical user text (single-sourced in
 * core/contracts), plan blocks are UI-only and filtered, and dangling
 * tool calls (an aborted turn) get the interrupted-result synthesis the
 * provider protocol demands.
 *
 * Answers (fork 1, owner 2026-09-26): the learner's answer IS the tool
 * call's ToolResultMessage — appended natively at answer time. The
 * synthetic "question posed" placeholder is an in-memory loop device
 * (Wave A's terminate) and is never persisted: the record ends at the
 * unanswered call in the pose→answer window, where no turn can run (the
 * question gate holds steers; a POST would 409).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "./pending.ts";
import {
	CONCLUDE_ACK_TEXT,
	HANDOFF_TEXT,
	NEXT_PROBLEM_TEXT,
	THINKING_LABEL,
} from "./contracts/chat.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "./question-core.ts";
import { activeCompactionOf, keptIndexFor } from "./compaction.ts";

/** The hard-invariant wording for an aborted turn's unanswered calls —
 *  carried over verbatim from the pre-native era so the model's view
 *  never drifted. */
export const INTERRUPTED_TEXT =
	"The question was interrupted — the learner never answered; continue without holding a result for it.";

// ─── The record's message type ───────────────────────────────────────────────

/**
 * The app's custom message (declaration-merged into pi-agent-core's
 * CustomAgentMessages below). Shaped like pi's own CustomMessage —
 * `content` is the MODEL-facing text (single-sourced in core/contracts,
 * never fake human speech), `details` is the UI payload (never
 * model-visible), `display` marks messages the UI renders (our projection
 * keys rendering on customType; the flag documents intent).
 */
export interface LhMarkerMessage {
	/** Record identity (pi messages carry no id — see the file header). */
	id: string;
	role: "custom";
	customType:
		| "graph-context"
		| "probe-handoff"
		| "subagent-steer"
		| "subagent-abort"
		| "plan-block"
		| "practice-thinking"
		| "practice-next"
		| "problem-dismissed"
		| "compaction";
	/** The model-facing text ("" for plan blocks — UI-only). */
	content: string;
	display: boolean;
	/** The UI payload — per-customType, never model-visible. */
	details: unknown;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		lhMarker: LhMarkerMessage;
	}
}

/** A record message: a native pi message (or our marker) plus the record id. */
export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & { id: string };

/** A record message list is assignable to the agent's context — that IS
 *  the replay (ui-stream/chat-handler assign it to initialState.messages). */
export function asAgentMessages(messages: readonly LhMessage[]): AgentMessage[] {
	return messages as unknown as AgentMessage[];
}

// ─── explicit learner-facing output ─────────────────────────────────────────

export const SEND_TO_USER_TOOL = "send_to_user";

/** Read the output tool's message without changing the native call. Also
 * accepts partial arguments while streaming; malformed/empty inputs carry
 * no prose. This projection is independent of the currently selected model. */
export function sendToUserText(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
	if (call.type !== "toolCall" || call.name !== SEND_TO_USER_TOOL) return undefined;
	if (!call.arguments || typeof call.arguments !== "object") return undefined;
	const message = (call.arguments as { message?: unknown }).message;
	return typeof message === "string" && message.trim() ? message : undefined;
}

/** Learner-facing prose, in content order. Only the explicit output tool
 * joins ordinary text here — thinking and all other tool inputs stay out.
 * Shared by coverage/extraction and Markdown; native history stays intact. */
export function userFacingTextOf(content: unknown, failedOutputCalls?: ReadonlySet<string>): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "toolCall" && failedOutputCalls?.has(block.id)) continue;
		const text = block.type === "text" ? block.text : sendToUserText(block);
		if (typeof text === "string" && text.trim()) out.push(text);
	}
	return out;
}

/** Failed output calls remain retry context, not delivered teaching.
 * Truncated calls can have valid-looking partial arguments. Failed/aborted
 * generations do not execute their calls at all, so may have no result. */
export function failedOutputCallIds(messages: readonly LhMessage[]): ReadonlySet<string> {
	const failed = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === SEND_TO_USER_TOOL && message.isError) {
			failed.add(message.toolCallId);
		} else if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === SEND_TO_USER_TOOL) failed.add(block.id);
			}
		}
	}
	return failed;
}

// ─── id minting ──────────────────────────────────────────────────────────────

/** The app-wide message id shape (same as the UIMessage-era mint). */
export function newMessageId(): string {
	return `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

// ─── constructors (the input-event → native append mapping lives in
//     core/input-events.ts; steers in core/contracts/jobs.ts) ─────────────────

/** A learner-authored user message (text input, verdict note). */
export function newUserMessage(text: string): LhMessage & UserMessage {
	return {
		id: newMessageId(),
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/** A steered user message (mid-turn composer steering, owner 2026-10-03):
 *  a plain user message with the CLIENT-minted steer id — the same object
 *  rides agent.steer(), the live stream's message events, and the settled
 *  record, so the optimistic queued indicator and the transcript card
 *  upsert by one identity. */
export function newUserSteer(text: string, id: string): LhMessage & UserMessage {
	return { id, role: "user", content: text, timestamp: Date.now() };
}

/** The learner's answer — the question call's tool result (fork 1).
 *  TWO AUDIENCES (owner, tool-result diet 2026-10-02): the MODEL sees the
 *  compact learner-only record (compactAnswerForModel — the call's own
 *  arguments already carry the question/options/explanation/commitment;
 *  restating them doubled every answer's tokens), while `details` keeps
 *  the FULL graded QuestionAnswerData for the record and the UI. */
export function newAnswerResult(
	toolCallId: string,
	toolName: string,
	answer: unknown,
): LhMessage & ToolResultMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(answer as QuestionAnswerData)) }],
		// 0.87.1 narrowed ToolResultMessage.details to JsonRepresentation —
		// our payloads are JSON-safe answer structures, so the cast is honest.
		details: answer as ToolResultMessage["details"],
		isError: false,
		timestamp: Date.now(),
	};
}

/** The probe→teach handoff wake: scaffolding, not speech — the model reads
 *  HANDOFF_TEXT, the UI renders the quiet system line. */
export function newHandoffMessage(chatId: string): LhMarkerMessage {
	return {
		id: `steer_probe_${chatId}`,
		role: "custom",
		customType: "probe-handoff",
		content: HANDOFF_TEXT,
		display: true,
		details: { chatId },
		timestamp: Date.now(),
	};
}

/** The plan presentation block: pure UI history (a frozen snapshot), no
 *  model face — toLlmMessages filters it. `planCallId` keys idempotent
 *  emission (one block per successful plan_init call). */
export function newPlanBlockMessage(
	planCallId: string,
	block: unknown,
): LhMarkerMessage {
	return {
		id: `pb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		role: "custom",
		customType: "plan-block",
		content: "",
		display: true,
		details: { planCallId, block },
		timestamp: Date.now(),
	};
}

// ─── practice sessions (owner, 2026-10-04) ───────────────────────────────────

/** The practice agent's two tools (the conclude-before-next-problem gate's
 *  vocabulary — the tool-execute layer owns the tools themselves). */
export const PRACTICE_PROBLEM_TOOL = "problem";
export const PRACTICE_CONCLUDE_TOOL = "conclude";

/** One picked proposition of the graph-context marker (the learner's map
 *  pick — name + statement as the learner SAW them at pick time). */
export interface GraphContextPick {
	id: string;
	name: string;
	statement: string;
}

/** The session's map context (owner, 2026-10-04): a SEPARATE custom
 *  message BEFORE the learner's first user message — the picked
 *  propositions plus the reasoning chains among them (pre-formatted
 *  lines, formatChainLine shape). The model reads `content` (flattened
 *  to a user message by toLlmMessages like every marker); `details`
 *  feeds the transcript's collapsible GraphContextCard. No more seed
 *  text glued into the first prompt. */
export function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage {
	// IDS FIRST (owner round 9, 2026-10-05 — the mastery-trace contract):
	// each proposition is introduced ONCE with its id, name, and statement;
	// the problem tool's `target` field takes these ids (names normalize to
	// ids at the seam). Chains below stay NAMES — they are comprehension
	// context, not tags; names read, ids reference.
	const lines = [
		// PREAMBLE LAW (owner, 2026-10-10): custom markers flatten to
		// USER-role messages on the wire (toLlmMessages) — this text arrives
		// in the learner's voice channel, so it must not read like a system
		// broadcast. The bracket convention (NEXT_PROBLEM_TEXT's kin) marks
		// it honestly as injected session context, not learner speech.
		"[Session context] — picked from the learner's knowledge map when starting this session:",
		"",
		"Propositions (id — name: statement; the problem tool's target field uses these ids):",
		...picks.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`),
	];
	if (chains.length > 0) {
		lines.push("", "Reasoning chains among them (premises → conclusion):", ...chains.map((c) => `- ${c}`));
	}
	return {
		id: newMessageId(),
		role: "custom",
		customType: "graph-context",
		content: lines.join("\n"),
		display: true,
		details: { propositions: picks, chains },
		timestamp: Date.now(),
	};
}

/** The learner's thinking submission (ONE send lane, owner round
 *  2026-10-05): the register is no longer declared by a button — the
 *  model READS the text to tell working traces from claimed answers. The
 *  content label is the single "Your thinking"; `details` keeps the raw
 *  payload for the transcript card. One problem may carry many
 *  submissions. */
export function newThinkingMessage(problemCallId: string, text: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-thinking",
		content: `${THINKING_LABEL}:\n${text}`,
		display: true,
		details: { problemCallId, text },
		timestamp: Date.now(),
	};
}

/** The learner's explicit move-on signal (owner round 16): appended by
 *  the next input (the composer band's chip, or Enter on an empty
 *  composer during the between-problems pause). The content is the
 *  single-sourced NEXT_PROBLEM_TEXT — the model's unambiguous go-ahead;
 *  the transcript renders its own compact line off the marker (never
 *  the content). */
export function newNextMessage(): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-next",
		content: NEXT_PROBLEM_TEXT,
		display: true,
		details: {},
		timestamp: Date.now(),
	};
}

/** The problem-dismissal marker (ask-style discard, owner 2026-10-04):
 *  UI-ONLY — toLlmMessages filters it. The model's face arrives later, at
 *  the user's next input, as the synthesized conclude pair
 *  (concludedByDismissalPair below) — the agent sees the dismissal as a
 *  conclude call it "made" with outcome "dismissed", so the slot-freed
 *  state and the dismissal read through the one vocabulary it owns. */
export function newProblemDismissedMarker(problemCallId: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "problem-dismissed",
		content: "",
		display: true,
		details: { problemCallId },
		timestamp: Date.now(),
	};
}

/** The dismissal's deferred conclude (owner ruling 2026-10-04): the pair
 *  prepended to the user's NEXT input — a synthetic assistant message
 *  carrying a conclude call (outcome "dismissed") plus its ack result, so
 *  both the record and the model context read the problem as concluded
 *  by dismissal, slot freed. Pure; ids are deterministic off the problem
 *  call id (idempotent shape — the pending-dismissal gate guarantees the
 *  pair appends at most once per marker). */
export function concludedByDismissalPair(
	problemCallId: string,
): [LhMessage & AssistantMessage, LhMessage & ToolResultMessage] {
	const callId = `call_conc_${problemCallId}`;
	const now = Date.now();
	// The stamps are placeholders by design: history serialization reads
	// ONLY the content blocks (verified in pi-ai's converters), and the
	// app's money channel is the parallel turns log, never message
	// objects — so "synthetic" never corrupts a wire view or a cost fold.
	const syntheticStamps = {
		api: "faux",
		provider: "synthetic",
		model: "synthetic-conclude",
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
	return [
		{
			id: newMessageId(),
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "dismissed" } }],
			timestamp: now,
			...syntheticStamps,
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: callId,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
			details: { outcome: "dismissed", problemCallId },
			isError: false,
			timestamp: now,
		},
	];
}

/** The active-problem fold (the conclude-before-next-problem gate): the
 *  NEWEST problem tool call with nothing concluding after it — either a
 *  conclude call or a dismissal marker deactivates. The ack result at pose
 *  time does NOT (the problem stays on screen through nudges; the dock's
 *  subject is the call, not a dangling result). */
/** The ids of tool calls whose results are CLEAN (not errored) — the only
 *  calls that ever happened, per the honest-activation ruling. */
function cleanToolCallIds(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (!result.isError) ids.add(result.toolCallId);
	}
	return ids;
}

/** The conclusion's reveal (owner round, 2026-10-05): the hero of a
 *  conclude card is the modelSolution committed at POSE time — the newest
 *  cleanly-posed problem BEFORE this conclude call. The reveal is never
 *  re-authored (the slim schema dropped solutionReveal); legacy conclude
 *  inputs that still carry their own solutionReveal fall back to it at the
 *  card. Undefined when the pose carries no string solution. */
export function modelSolutionForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): string | undefined {
	const input = problemInputForConclude(messages, concludeCallId);
	return typeof input?.modelSolution === "string" ? input.modelSolution : undefined;
}

/** The full pose-side fold (owner round 17, 2026-10-06 — observability):
 * EVERYTHING the agent filled into the problem call — mode, target ids,
 * statement, the committed solution — joined onto the conclude part so
 * the card's collapsible "agent's data" drawer renders pure. Same walk
 * and refusal law as the reveal: a pose the record never acked (a
 * refused call) folds nothing. */
export function problemInputForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown } | undefined {
	let mi = messages.findIndex(
		(m) =>
			(m as { role?: string }).role === "assistant" &&
			(m as AssistantMessage).content.some(
				(b) => b.type === "toolCall" && b.id === concludeCallId,
			),
	);
	if (mi < 0) return undefined;
	const clean = cleanToolCallIds(messages);
	for (; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
			const block = assistant.content[bi]!;
			if (block.type !== "toolCall" || block.name !== PRACTICE_PROBLEM_TOOL) continue;
			if (!clean.has(block.id)) continue; // a refused pose revealed nothing
			return (block.arguments ?? undefined) as
				| { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown }
				| undefined;
		}
	}
	return undefined;
}

export function activeProblemOf(
	messages: readonly LhMessage[],
): { toolCallId: string; input: unknown } | null {
	// HONEST ACTIVATION (owner ruling, 2026-10-05 — the BKT incident):
	// calls count only through their RESULTS — a problem activates on its
	// clean ack, a conclude frees on its clean ack; errored and dangling
	// calls are skipped ("either it goes through or it doesn't").
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") return null;
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage & { id: string };
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall") continue;
				if (block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN conclude frees
					continue; // errored/dangling conclude: the free never happened
				}
				if (block.name !== PRACTICE_PROBLEM_TOOL) continue;
				if (cleanCallIds.has(block.id)) return { toolCallId: block.id, input: block.arguments };
				// errored/dangling pose — it did not go through; keep scanning
			}
			continue;
		}
	}
	return null;
}

/** Is a problem-dismissal marker waiting for its conclude synthesis? The
 *  text/continue appends read this: the pair rides the user's next input
 *  (input-events). Newest-marker-wins scan: the first dismissal marker or
 *  conclude call from the end decides. */
export function pendingProblemDismissalOf(messages: readonly LhMessage[]): string | null {
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") {
				return (marker.details as { problemCallId?: unknown }).problemCallId as string;
			}
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall" && block.type !== "text") continue;
				if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN conclude settles it
					continue; // errored/dangling: it never happened
				}
				if (block.type === "toolCall" && block.name === PRACTICE_PROBLEM_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN pose supersedes it
					continue;
				}
			}
			continue;
		}
	}
	return null;
}

// ─── the one model-facing seam (the agent's convertToLlm) ────────────────────

/** The ids of every toolResult in the tail (for the dangling-call scan). */
function resultIdsFrom(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult") {
			ids.add((m as ToolResultMessage).toolCallId);
		}
	}
	return ids;
}

/**
 * AgentMessage[] → the provider wire (the agent's convertToLlm — required
 * by pi-agent-core's loop config, the ONE place model-facing decisions
 * live):
 *
 * - user / assistant / toolResult pass through VERBATIM — signatures,
 *   usage, provider stamps all native — minus our record-`id` field.
 * - markers flatten to a user message carrying their content (the
 *   canonical text single-sourced in core/contracts); plan blocks are
 *   UI-only and filtered.
 * - dangling tool calls (an aborted turn's unanswered questions) get the
 *   synthesized interrupted result — the provider protocol's hard
 *   invariant: a tool call must be followed by its result.
 *
 * Contract (pi-agent-core): never throws — an unknown shape passes
 * through untouched rather than killing the loop.
 */
export function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
	// THE COMPACTION CUT (owner round 14, 2026-10-05): the ACTIVE marker
	// (the newest — chained compactions rule last) names the first kept
	// message; everything before it is replaced by the marker's content
	// (header + summary) rendered ONCE, up top. The marker itself is then
	// skipped in place — it must never render twice. A cut naming a
	// missing id degrades honestly (everything renders — never throw).
	const lhMessages = messages as readonly LhMessage[];
	const active = activeCompactionOf(lhMessages);
	let start = 0;
	let head: Message | null = null;
	if (active) {
		const kept = keptIndexFor(lhMessages, active);
		if (kept > 0) {
			start = kept;
			head = {
				role: "user",
				content: [{ type: "text", text: active.content }],
				timestamp: active.timestamp,
			};
		}
	}
	// THE LEADING SYSTEM MESSAGE IS REQUEST CHROME, NEVER COMPACTABLE
	// PAYLOAD (the OpenRouter no-tools incident, owner 2026-10-05):
	// pi-agent-core's Agent seeds a SystemMessage carrying the system
	// prompt AND the tool declarations at state.messages[0]
	// (createInitialSystemMessage — "messages declare the provider-visible
	// loadout"). The record never persists it (ui-stream's settleWith
	// filters the role), so RECORD-path callers never see it — but the
	// Agent's convertToLlm DOES. The cut slices the RECORD's history;
	// when [0] is the chrome it must carry through AHEAD of the
	// compaction head, exactly as pi's own prepareRequest re-applies
	// context.systemPrompt + context.tools around its projection.
	const leading =
		(messages[0] as { role?: string } | undefined)?.role === "system" ? (messages[0] as Message) : null;
	const out: Message[] = [];
	if (leading) out.push(leading);
	if (head) out.push(head);
	for (let i = leading ? Math.max(start, 1) : start; i < messages.length; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			// UI-only markers: plan blocks, and problem dismissals (the
			// synthesized conclude pair carries the model's face).
			if (marker.customType === "plan-block" || marker.customType === "problem-dismissed") continue;
			// The ACTIVE compaction marker already rendered as the head —
			// never twice. (Stale markers before the cut are unreachable; a
			// marker whose cut could not resolve has no head and renders as
			// its user text — honest degradation.)
			if (marker.customType === "compaction" && head !== null && marker.id === active!.id) continue;
			out.push({
				role: "user",
				content: [{ type: "text", text: marker.content }],
			timestamp: marker.timestamp,
			});
			continue;
		}
		// Strip the record id: the wire carries the native shape only.
		const { id: _id, ...native } = m as LhMessage;
		out.push(native as Message);
		// Dangling-call synthesis: an assistant message whose toolCalls have
		// no results in the remaining tail (abort mid-question) — the
		// provider rejects unanswered calls outright.
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			const calls = assistant.content.filter((b) => b.type === "toolCall");
			if (calls.length === 0) continue;
			const answered = resultIdsFrom(messages.slice(i + 1));
			for (const call of calls) {
				if (answered.has(call.id)) continue;
				out.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: INTERRUPTED_TEXT }],
					isError: false,
					timestamp: assistant.timestamp,
				});
			}
		}
	}
	return out;
}

// ─── native scans (the UIMessage-era pending/phase seams, natively) ──────────

/** The pending-question gate (findPendingToolCall's native twin): the
 *  NEWEST assistant message's FIRST question-tool call with no result in
 *  the tail — one question at a time, the dock's subject. */
export function danglingQuestionOf(
	messages: readonly LhMessage[],
): { toolCallId: string; tool: string; input: unknown } | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage & { id: string };
		const answered = resultIdsFrom(messages.slice(mi + 1));
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (!(QUESTION_TOOLS as readonly string[]).includes(block.name)) continue;
			if (answered.has(block.id)) continue;
			return { toolCallId: block.id, tool: block.name, input: block.arguments };
		}
		return null; // the newest assistant message's questions are all answered
	}
	return null;
}

/** The probe→teach construction seam (chat-handler): a probe_done call in
 *  the transcript — any state — means the probe is concluded: teach. */
export function hasProbeDone(messages: readonly LhMessage[]): boolean {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.name === "probe_done")) return true;
	}
	return false;
}

/** Every toolResult id in the record — answer-event validation (the call
 *  must be a DANGLING question call, not an already-answered one). */
export function answeredCallIds(messages: readonly LhMessage[]): Set<string> {
	return resultIdsFrom(messages);
}

// ─── the continuation fold (Wave D: the SDK's
//     lastAssistantMessageIsCompleteWithToolCalls, natively) ──────────────────

/**
 * Does the record END on un-consumed tool results — a turn that stopped
 * after its tools ran (a job dispatch's ack, an aborted answer turn),
 * leaving the agent owing a continuation? This is the mount/sync
 * continuation seam's gate (chat.tsx): when true and nothing runs, the
 * client sends {type:"continue"} and the teacher picks up from the record.
 *
 * The pre-Wave-D client asked the SDK's
 * lastAssistantMessageIsCompleteWithToolCalls (last view message is
 * assistant; its last step's tool calls all output-available or
 * output-error; at least one). The native fold over the record: the last
 * message is a toolResult, and the results' OWNING assistant message has
 * at least one call, ALL of them answered (a dangling question — the
 * dock's domain — fails the all-answered rule and never fires a turn,
 * exactly as the SDK's every(output-available) did).
 */
/** Is this record message a user-dismissed question result? The full
 *  answer rides the toolResult's `details` (newAnswerResult) — the
 *  dismissal pause and the continuation fold both read it. */
function isDismissedResult(m: LhMessage): boolean {
	if ((m as { role?: string }).role !== "toolResult") return false;
	const details = (m as { details?: unknown }).details as { dismissed?: unknown } | undefined;
	return details?.dismissed === true;
}

/** The dismissal pause (owner design 2026-10-03, "A2"): the record ends
 *  in user dismissal — the session waits for the USER. While paused,
 *  nothing auto-wakes: the continuation fold demands nothing (below) and
 *  the wake pipeline holds job deliveries in the steer queue until the
 *  next send. Derived from the tail — no latch to persist or clear; any
 *  user message flips it off by changing the record. */
export function endsInDismissal(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last !== undefined && isDismissedResult(last);
}

export type RequestCause = "foreground" | "background";
export type ReconstructedCause = RequestCause | "ambiguous";
export type NativeInputCause = "learner" | "automatic" | "neutral" | "unrecognizable";
/** Native causes only: flattened user roles, IDs' prefixes and prose confer no permission. */
export function nativeInputCause(message: AgentMessage, history: readonly AgentMessage[]): NativeInputCause {
	if (message.role === "user") return "learner";
	if (message.role === "system" || message.role === "assistant") return "neutral";
	if (message.role === "custom") {
		if (["probe-handoff", "subagent-steer", "subagent-abort"].includes(message.customType)) return "automatic";
		if (["practice-thinking", "practice-next"].includes(message.customType)) return "learner";
		return ["graph-context", "plan-block", "problem-dismissed", "compaction"].includes(message.customType) ? "neutral" : "unrecognizable";
	}
	if (message.role === "toolResult") {
		if (!(QUESTION_TOOLS as readonly string[]).includes(message.toolName) || message.isError || message.details == null || (message.details as { dismissed?: boolean }).dismissed) return "neutral";
		const details = message.details as Partial<QuestionAnswerData>;
		if (!["quiz", "ask", "explain"].includes(details.kind ?? "") || typeof details.questionText !== "string" || typeof details.dontKnow !== "boolean" || !Array.isArray(details.answers) || typeof details.answeredAt !== "string") return "unrecognizable";
		const calls = history.flatMap((m) => m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall" && b.id === message.toolCallId) : []);
		return calls.length === 1 && calls[0]?.type === "toolCall" && calls[0].name === message.toolName ? "learner" : "unrecognizable";
	}
	return "unrecognizable";
}
/** Full persisted native record, including pre-compaction causes. Never guessed foreground. */
export function reconstructRequestCause(messages: readonly LhMessage[]): ReconstructedCause {
	let inherited: ReconstructedCause = "ambiguous";
	let triggers: NativeInputCause[] = [];
	const seen = new Map<string, string>();
	const history: AgentMessage[] = [];
	const resolve = (): ReconstructedCause => {
		if (triggers.includes("unrecognizable")) return "ambiguous";
		const lastLearner = triggers.lastIndexOf("learner"), lastAutomatic = triggers.lastIndexOf("automatic");
		if (lastLearner < 0 && lastAutomatic < 0) return inherited;
		if (lastAutomatic < 0) return "foreground";
		if (lastLearner < lastAutomatic) return "background";
		return "ambiguous";
	};
	for (const message of messages) {
		const cause = nativeInputCause(message, history);
		const id = (message as { id?: string }).id;
		if (id) {
			const value = JSON.stringify(message);
			if (seen.has(id)) { if (seen.get(id) !== value) triggers.push("unrecognizable"); continue; }
			seen.set(id, value);
		} else if (cause !== "neutral") triggers.push("unrecognizable");
		if (message.role === "assistant" && !(message.provider === "synthetic" && message.api === "faux" && message.model === "synthetic-conclude" && message.content.some((b) => b.type === "toolCall" && b.name === "conclude" && b.arguments?.outcome === "dismissed"))) {
			inherited = resolve(); triggers = [];
		} else if (cause !== "neutral") triggers.push(cause);
		history.push(message);
	}
	return resolve();
}

export function needsContinuation(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || (last as { role?: string }).role !== "toolResult") return false;
	// The trailing results batch (contiguous by construction — the agent
	// appends its batch; the question gate keeps a quiz call and its
	// learner answer adjacent).
	let start = messages.length - 1;
	while (
		start > 0 &&
		(messages[start - 1] as { role?: string } | undefined)?.role === "toolResult"
	) {
		start--;
	}
	// The dismissal rule (A2 + owner ruling 2026-10-03, round-1 incident):
	// the batch's LAST resolution decides. Ending on a dismissal = the
	// user signaled STOP — no wake, no reaction owed now; the answers'
	// reactions ride the user's next plain message. Ending on a real
	// answer = the reaction is owed. One law with the pump's pause
	// (endsInDismissal reads the same last result), so continuation,
	// delivery-holding, and the pause can never disagree.
	if (isDismissedResult(messages[messages.length - 1]!)) {
		return false;
	}
	const owner = messages[start - 1];
	if (!owner || (owner as { role?: string }).role !== "assistant") return false;
	const content = (owner as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const results = messages.slice(start) as ToolResultMessage[];
	// PRACTICE (owner design, 2026-10-04): a batch acking a problem POSE
	// owes nothing — terminate:true ended that turn DELIBERATELY (the
	// learner's next thinking submission is the next turn), and unlike a
	// question's placeholder this ack PERSISTS (the model reads its own
	// "Problem posed" result later). Without this fold a reload after a
	// pose would wake a phantom continuation turn.
	const posedProblem = results.some(
		(m) => m.toolName === PRACTICE_PROBLEM_TOOL && !m.isError && m.details == null,
	);
	if (posedProblem) return false;
	const answered = new Set(results.map((m) => m.toolCallId));
	const calls = (content as Array<{ type?: string; id?: string }>).filter(
		(b) => b.type === "toolCall" && typeof b.id === "string",
	);
	return calls.length > 0 && calls.every((b) => answered.has(b.id!));
}

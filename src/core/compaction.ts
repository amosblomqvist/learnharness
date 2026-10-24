/**
 * COMPACTION (owner round 14, 2026-10-05): the context-fitting mechanic,
 * with a bounded local port of Pi coding-agent 1.4.0 cutoff selection.
 * No coding-agent dependency. See docs/compaction-accounting.md for the
 * behavior boundary, native golden fixtures, and upstream MIT notice.
 *
 * THE CONTRACT: full history stays persisted in the record — extraction
 * and the user's transcript keep reading everything. A compaction marker
 * (LhMarkerMessage, customType "compaction") carries a summary plus the
 * cut (firstKeptMessageId); toLlmMessages — the ONE model-facing seam —
 * projects [summary] + [messages from the cut onward] on every request.
 * The live agent never holds dropped messages because every run is built
 * fresh from the record: question/problem poses terminate their runs, so
 * the "user is thinking" pause is always a BETWEEN-RUNS window —
 * compaction kicks at turn settle (running during the pause) and every
 * turn start awaits the gate. No mid-run surgery exists.
 *
 * Trigger threshold (owner ruling): effective = min(settings threshold,
 * model contextWindow − 16k reserve). Defaults: threshold 150k, kept
 * tail ~20k recent tokens (pi's defaults, owner-approved). Token
 * estimation follows pi's law (2026-10-05 incident fix): anchor on the
 * provider-reported usage of the last assistant message, chars/4 only
 * for messages appended after that anchor; the heuristic alone runs
 * only when no usage exists yet.
 *
 * Summary content (owner's three requirements + continuity): the
 * learner's understanding and its EVOLUTION (quiz outcomes, confidence,
 * misconceptions — a detailed picture of what the user knows), the
 * teaching arc / session progression, and the plan dependency tree
 * VERBATIM (from record.tree — the plan_init tool result may fall before
 * the cut, so the marker re-injects it). Plus the current moment (any
 * pending question/problem and the immediate next step) so the post-cut
 * model can continue mid-thought.
 */

import type { PlanTree } from "./contracts/plan.ts";
import { derivePlanStatusesLh, derivedNodeStatus } from "./contracts/plan.ts";
import { COMPACTED_HISTORY_HEADER } from "./contracts/chat.ts";
import type { LhMessage, LhMarkerMessage } from "./native-messages.ts";
import { newMessageId } from "./native-messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, SystemMessage } from "@earendil-works/pi-ai";

// ─── constants (the tunables, owner-approved) ────────────────────────────────

/** Kept-recent tail budget (pi's default, owner-approved 2026-10-05):
 * ~20k tokens of verbatim recent transcript always ride after the
 * summary — recency is cheap insurance against summary loss. */
export const KEEP_RECENT_TOKENS = 20_000;

/** The reserve subtracted from the model's contextWindow when the window
 * (not the user's threshold) is the binding constraint (pi's default). */
export const COMPACTION_RESERVE_TOKENS = 16_384;

/** Factory default for the settings threshold (owner ruling: 150k). */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 150_000;

/** Tool-result truncation when serializing the span for the summarizer
 * (pi's mirror: long job/research results don't need verbatim inclusion
 * in the SUMMARY INPUT — the kept tail carries them whole). */
const SUMMARY_TOOL_RESULT_TRUNCATE = 2_000;

// ─── token estimation (pi's law: usage-anchored, chars/4 only for the tail) ─

/** Context tokens from a provider-reported usage block — the most honest
 * measure of "what the last request actually carried." Mirrors pi's
 * calculateContextTokens. */
export function calculateContextTokens(usage: {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): number {
	return (
		usage.totalTokens ||
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

/** Pi 1.4.0's heuristic: text + thinking + toolCall name/args for
 * assistants, content text plus a fixed image allowance for other roles. NEVER JSON.stringify of the
 * whole message — record scaffolding (ids, usage, responseId, app-side
 * details, escaped quotes/backslashes) inflates ~3x (measured on the
 * 2026-10-05 relational-databases incident: 84k estimated vs ~30k real). */
export function estimateMessageTokens(message: LhMessage | AgentMessage): number {
	const content: unknown = (message as { content?: unknown }).content;
	let chars = 0;
	if ((message as { role?: string }).role === "assistant") {
		for (const block of (Array.isArray(content) ? content : []) as Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: unknown;
		}>) {
			if (block.type === "text") chars += block.text?.length ?? 0;
			else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
			else if (block.type === "toolCall") chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
		}
	} else {
		chars += textCharsOfContent(content);
		if (message.role === "system") {
			const system = message as SystemMessage;
			for (const section of Object.values(system.sections ?? {})) chars += section?.length ?? 0;
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
		}
	}
	return Math.ceil(chars / 4);
}

// Pi coding-agent 1.4.0 estimateTokens: fixed image allowance, NOT a
// measurement of encrypted reasoning or actual provider vision tokens.
const ESTIMATED_IMAGE_CHARS = 4_800;
function textCharsOfContent(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Array<string | { type?: string; text?: string }>) {
		if (typeof block === "string") chars += block.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
		else if (block?.type === "text") chars += block.text?.length ?? 0;
	}
	return chars;
}

/** The newest assistant message carrying VALID provider-reported usage
 * (pi's rule: skip aborted/error messages and all-zero usage — they carry no
 * truth about the wire). The scan STOPS at the newest compaction
 * marker: usage captured before a compaction described the pre-cut
 * context — the next request carries the summary + kept tail instead,
 * so pre-marker usage is not a valid anchor (pi's "don't trust usage
 * captured before a later compaction" law). Index into messages, or
 * null. */
export function lastAssistantUsageIndex(
	messages: readonly (LhMessage | AgentMessage)[],
): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role === "custom" && (m as LhMarkerMessage).customType === "compaction") return null;
		if ((m as { role?: string }).role !== "assistant") continue;
		const a = m as AssistantMessage & { stopReason?: string };
		if (a.stopReason === "aborted" || a.stopReason === "error") continue;
		if (calculateContextTokens((a.usage ?? {}) as Parameters<typeof calculateContextTokens>[0]) === 0) continue;
		return i;
	}
	return null;
}

export interface ContextTokenEstimate {
	/** The estimate the trigger should compare against the threshold. */
	tokens: number;
	/** Provider-reported tokens from the usage anchor (0 when unanchored). */
	usageTokens: number;
	/** chars/4-estimated tokens after the anchor (or everything, unanchored). */
	trailingTokens: number;
	/** Index of the usage anchor, or null (diagnostics). */
	lastUsageIndex: number | null;
}

/** THE trigger estimator (pi's estimateContextTokens): anchor on the last
 * assistant usage the provider reported — prompt, tools, tokenizer
 * density and all — and chars/4-estimate ONLY what was appended after
 * it. The heuristic never re-estimates history the provider already
 * counted (the relational-databases bug: full-record JSON.stringify/4
 * tripled the true context and fired a 30k session at an 80k threshold). */
export function estimateContextTokens(
	messages: readonly (LhMessage | AgentMessage)[],
): ContextTokenEstimate {
	const anchor = lastAssistantUsageIndex(messages);
	if (anchor === null) {
		let trailing = 0;
		for (const m of messages) trailing += estimateMessageTokens(m);
		return { tokens: trailing, usageTokens: 0, trailingTokens: trailing, lastUsageIndex: null };
	}
	const anchored = messages[anchor]! as AssistantMessage;
	const usageTokens = calculateContextTokens(anchored.usage as Parameters<typeof calculateContextTokens>[0]);
	let trailing = 0;
	for (let i = anchor + 1; i < messages.length; i++) trailing += estimateMessageTokens(messages[i]!);
	return { tokens: usageTokens + trailing, usageTokens, trailingTokens: trailing, lastUsageIndex: anchor };
}

/** Estimate a whole message list (the plain heuristic — cut-walk use). */
export function estimateTokens(messages: readonly (LhMessage | AgentMessage)[]): number {
	let total = 0;
	for (const m of messages) total += estimateMessageTokens(m);
	return total;
}

// ─── the cut walk ────────────────────────────────────────────────────────────

/** Model-visible entry adapter for the local Pi 1.4.0 cutoff port.
 * Compaction entries are boundaries, not ordinary cut candidates; UI-only
 * markers have no context, just like native metadata entries. */
function cutMessage(message: LhMessage): LhMessage | null {
	if (message.role !== "custom") return message;
	if (["compaction", "plan-block", "problem-dismissed"].includes(message.customType)) return null;
	return message;
}

/** Local port of pi-coding-agent 1.4.0 findCutPoint (MIT).
 * Walk backwards to >= budget, then choose the nearest valid cut AT OR
 * AFTER that entry. If oversized trailing results exhaust the budget,
 * retain their preceding assistant call, not the entire session.
 * No encrypted-signature sizing and no exact retained-token guarantee.
 * Returns the first kept record index; a zero/no-progress cut drops nothing.
 * Keep this and estimateMessageTokens aligned deliberately when upgrading Pi.
 */
export function compactionCutIndex(messages: readonly LhMessage[], keepRecentTokens = KEEP_RECENT_TOKENS): number {
	const previous = activeCompactionOf(messages);
	const previousKept = previous ? keptIndexFor(messages, previous) : -1;
	const start = Math.max(0, previousKept);
	const points: number[] = [];
	for (let i = start; i < messages.length; i++) {
		const message = cutMessage(messages[i]!);
		if (message && (message.role === "user" || message.role === "assistant" || message.role === "custom")) points.push(i);
	}
	if (!points.length) return start;
	let cut = points[0]!;
	let accumulated = 0;
	for (let i = messages.length - 1; i >= start; i--) {
		const message = cutMessage(messages[i]!);
		const tokens = message ? estimateMessageTokens(message) : 0;
		if (tokens === 0) continue;
		accumulated += tokens;
		if (accumulated >= keepRecentTokens) {
			cut = points.find((candidate) => candidate >= i) ?? points.at(-1)!;
			break;
		}
	}
	// Native entries preserve adjacent non-context metadata, but never walk
	// backwards across a previous compaction entry.
	while (cut > start) {
		const before = messages[cut - 1]!;
		if ((before.role === "custom" && before.customType === "compaction") || cutMessage(before)) break;
		cut--;
	}
	return cut;
}

// ─── the marker ──────────────────────────────────────────────────────────────

/** The compaction marker's details (UI payload — never model-visible;
 * the model sees content, the header + summary). */
export interface CompactionDetails {
	/** Record id of the first KEPT message: the projection renders the
	 * summary, then everything from this message onward. */
	firstKeptMessageId: string;
	/** The estimated context tokens that triggered this compaction
	 * (provenance for the divider's tooltip/dialog). */
	tokensBefore: number;
	/** provider:id of the model that wrote the summary (the session's
	 * own model — owner ruling; provenance, never a routing input). */
	model?: string;
	/** ISO timestamp of the compaction moment. */
	at: string;
}

/** Build the compaction marker. Content is the FULL model-facing text
 * (header + summary — single-sourced header); the marker rides the
 * record at the compaction MOMENT (near the transcript end), while the
 * cut it names sits deep in history: the UI renders both places. */
export function newCompactionMarker(summary: string, details: CompactionDetails): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "compaction",
		content: `${COMPACTED_HISTORY_HEADER}\n\n${summary.trim()}`,
		display: true,
		details,
		timestamp: Date.now(),
	};
}

/** The ACTIVE compaction marker: the newest one in the record (chained
 * compactions — the last one rules; older markers fall inside the
 * dropped span and never render). */
export function activeCompactionOf(messages: readonly LhMessage[]): (LhMarkerMessage & { details: CompactionDetails }) | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as LhMarkerMessage;
		if (marker.customType === "compaction") {
			const details = marker.details as Partial<CompactionDetails>;
			if (typeof details.firstKeptMessageId === "string") {
				return marker as LhMarkerMessage & { details: CompactionDetails };
			}
		}
	}
	return null;
}

/** The index of the first KEPT message, or -1 when the record's active
 * marker names an id that no longer exists (corrupt/foreign) — callers
 * fall back to rendering everything (honest degradation, never throw). */
export function keptIndexFor(messages: readonly LhMessage[], marker: LhMarkerMessage & { details: CompactionDetails }): number {
	const id = marker.details.firstKeptMessageId;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]!.id === id) return i;
	}
	return -1;
}

// ─── the summarizer input (pi's mirror: labeled text, truncated results) ─────

/** Serialize a message span as labeled text for the summarizer. Tool
 * results truncate at ~2k chars (the kept tail carries them verbatim for
 * the model; the SUMMARY only needs their gist). */
export function serializeForSummary(messages: readonly LhMessage[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "user") {
			lines.push(`[LEARNER] ${(m as { content: string }).content}`);
		} else if (role === "assistant") {
			const assistant = m as AssistantMessage;
			const blocks: string[] = [];
			for (const b of assistant.content) {
				if (b.type === "text") blocks.push(b.text);
				else if (b.type === "toolCall") blocks.push(`(tool call ${b.name}: ${JSON.stringify(b.arguments)})`);
				// thinking blocks: the model's private scratch — its
				// conclusions land in text; skip the noise
			}
			if (blocks.length > 0) lines.push(`[TUTOR] ${blocks.join("\n")}`);
		} else if (role === "toolResult") {
			const result = m as ToolResultMessage;
			const text = result.content
				.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
				.join("\n");
			lines.push(
				`[RESULT for ${result.toolName}${result.isError ? " (error)" : ""}] ${
					text.length > SUMMARY_TOOL_RESULT_TRUNCATE ? `${text.slice(0, SUMMARY_TOOL_RESULT_TRUNCATE)}…[truncated]` : text
				}`,
			);
		} else if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "plan-block") continue; // UI-only
			lines.push(`[SYSTEM NOTE] ${marker.content}`);
		}
	}
	return lines.join("\n\n");
}

/** Render the plan dependency tree verbatim (owner requirement: the tree
 * persists through compaction). Structure from record.tree, statuses
 * derived from the transcript (the record's own law: the tree carries
 * structure only). Empty tree → absent section (nothing persisted). */
export function planTreeToText(tree: PlanTree | undefined, messages: readonly LhMessage[]): string | null {
	if (!tree || tree.nodes.length === 0) return null;
	const statuses = derivePlanStatusesLh(tree, messages);
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	const lines: string[] = [];
	for (const node of tree.nodes) {
		const status = derivedNodeStatus(statuses, node.id);
		const summary = node.summary ? ` — ${node.summary}` : "";
		lines.push(`- [${status}] ${node.title} (${node.id})${summary}`);
	}
	for (const edge of tree.edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (from && to) lines.push(`- ${from.title} → ${to.title} (${from.id} → ${to.id})`);
	}
	return lines.join("\n");
}

/**
 * The summarizer prompt. The summary's REQUIRED SHAPE (owner rulings):
 * the learner's understanding AND its evolution, the teaching arc, the
 * plan tree verbatim, and the current moment — in that order of stress.
 * The summarizer is the session's own model (owner ruling), writing for
 * its own future self: the summary replaces everything before the cut.
 */
export function buildCompactionPrompt(input: {
	/** The span to summarize, pre-serialized (serializeForSummary). */
	spanText: string;
	/** The plan tree rendered (planTreeToText) or null. */
	planTreeText: string | null;
	/** The session kind (wording: tutor vs practice agent). */
	kind: "teach" | "practice" | "probe";
}): string {
	const planSection =
		input.planTreeText ?? "No plan tree exists in this session (nothing was persisted).";
	return `You are compacting the earlier part of a tutoring session — writing the summary your future self will read INSTEAD of that transcript. Everything before the cut is replaced by what you write; everything after stays verbatim. The learner's transcript below labels the learner as [LEARNER], the tutoring agent as [TUTOR], tool traffic as [RESULT …]/[SYSTEM NOTE].

Write the summary with EXACTLY these sections, in this order:

## The learner's understanding
The most detailed picture you can give of what this learner knows and how that EVOLVED across the session: what they answered and how well (quiz outcomes, correct reasoning, mistakes), their stated or displayed confidence, misconceptions that surfaced, which were corrected and which still stand. This section carries the most weight — future teaching decisions hang on it.

## The teaching arc
How the session progressed: what was covered and in what order, which explanations landed and which didn't, how the learner responded, where the momentum went. Include probe-phase findings if present.

## The plan dependency tree
Reproduce the session's current plan tree verbatim from the structure below — do not drop nodes, edges, or statuses.

${planSection}

## The current moment
What is happening RIGHT NOW at the cut: any question or problem awaiting the learner's answer, any commitment the agent has made that a later turn must honor, and the immediate next step.

Rules: no praise, no filler, no speculation beyond the transcript. Every claim about the learner must be traceable to what they actually said or answered. Keep every identifier (proposition ids, node ids, file paths) exact.

TRANSCRIPT TO SUMMARIZE:

${input.spanText}`;
}

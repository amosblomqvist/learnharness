/**
 * ASIDE THREADS (issue #16): the pure folds behind the side channel — the
 * bounded session snapshot an aside agent reads, and the prompt that wraps
 * it. Pure core by law (no IO, no React), so the bounds are pinned in tests
 * without an engine.
 *
 * THE NON-POLLUTION CONTRACT: asides live in ChatRecord.asides, never in
 * `messages`. Everything model-facing for the MAIN agents (toLlmMessages)
 * and every context-accounting fold (compaction, measured context) reads
 * `messages` only — an aside is invisible to the lesson by construction,
 * from either side: the tutor never reads the aside thread, and the aside
 * agent never reads more than the bounded excerpt built here.
 */

import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "./native-messages.ts";
import type { ChatKind } from "./contracts.ts";

/** How many recent USER-FACING messages (learner texts + tutor prose, tool
 *  traffic and thinking excluded) the aside snapshot carries. Bounded by
 *  design: an aside is a quick clarification, not a continuation of the
 *  lesson — the recent exchange plus the plan is enough context, and the
 *  bound keeps the one-shot synchronous request cheap. */
export const ASIDE_CONTEXT_MESSAGES = 12;

/** The last `limit` user-facing messages as a labeled excerpt
 * ([LEARNER]/[TUTOR] lines). Assistant prose folds through
 * userFacingTextOf — thinking blocks and tool calls stay out; failed
 * send_to_user calls stay out (they never delivered). Returns null when
 * the session has no user-facing exchange yet. */
export function asideContextExcerpt(
	messages: readonly LhMessage[],
	limit = ASIDE_CONTEXT_MESSAGES,
): string | null {
	const failedOutput = failedOutputCallIds(messages);
	const lines: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "user") {
			const text = (m as { content?: unknown }).content;
			if (typeof text === "string" && text.trim()) lines.push(`[LEARNER] ${text}`);
		} else if (role === "assistant") {
			const prose = userFacingTextOf((m as { content?: unknown }).content, failedOutput);
			if (prose.length > 0) lines.push(`[TUTOR] ${prose.join("\n")}`);
		}
	}
	if (lines.length === 0) return null;
	return lines.slice(-limit).join("\n\n");
}

/** The aside prompt: bounded excerpt + current plan + the question. The
 * system prompt (the answering doctrine) is server-owned
 * (src/server/asides.ts) — this is only the CONTEXT payload. */
export function buildAsidePrompt(input: {
	excerpt: string | null;
	/** planTreeToText(record.tree, record.messages) or null. */
	planTreeText: string | null;
	question: string;
	kind?: ChatKind;
}): string {
	const kind = input.kind ?? "teach";
	const excerpt = input.excerpt ?? "(The session has no learner/tutor exchange yet.)";
	const plan = input.planTreeText ?? "(No plan tree exists in this session.)";
	return [
		`A learner is mid-session with a ${kind === "practice" ? "practice agent posing problems" : "tutoring agent"} and has paused to ask you a quick aside question about it. You are NOT that agent; nothing you write enters the lesson.`,
		"",
		"RECENT SESSION EXCERPT (the tutor conversation, possibly truncated at the top):",
		excerpt,
		"",
		"THE SESSION'S CURRENT PLAN:",
		plan,
		"",
		"THE LEARNER'S ASIDE QUESTION:",
		input.question,
	].join("\n");
}

/** A thread id, the record-message mint's shape (client- and server-safe). */
export function newAsideThreadId(): string {
	return `aside_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

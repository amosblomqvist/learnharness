/**
 * Transcript-derived phases shared by server summaries and the browser.
 * A successful probe_done opens planning; the first valid node-tagged
 * quiz/explain starts teaching. Failed generations and rejected calls
 * never represent a posed teaching question.
 *
 * Initial plan approval authorizes a pose, but does not itself change the
 * phase. A successful resume_probe or a diagnostic plan-review choice
 * returns either fold to probe without removing history.
 *
 * Native results project back onto their calls in the view. Both folds
 * must agree on settled records, including failed and aborted generations.
 */
import { planReviewChoice } from "./question-core.ts";

/** The three phases of a session, as the picker / header / dividers see them. */
export type Phase3 = "probe" | "plan" | "teach";

/**
 * Minimal structural slice of a UI message for the phase scan: parts with
 * a state, an input (a tool call's parsed arguments), and (for concluded
 * calls) an output.
 */
export interface PhaseMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

/** A quiz call's part input carries `nodeId` iff it is tagged (teach-only —
 *  the probe quiz schema has no nodeId field). */
function taggedNodeId(input: unknown): boolean {
	return (
		typeof input === "object" &&
		input !== null &&
		typeof (input as { nodeId?: unknown }).nodeId === "string" &&
		(input as { nodeId: string }).nodeId.length > 0
	);
}

/** The phase at `upToIndex` (inclusive; default: the last message). */
export function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		phase = advance(phase, messages[i]?.parts);
	}
	return phase;
}

/** One message's advance of the phase (pure fold step). */
function advance(
	phase: Phase3,
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }> | undefined,
): Phase3 {
	if (!parts) return phase;
	for (const part of parts) {
		if (part.type === "tool-ask_user_question" && part.state === "output-available" &&
			planReviewChoice(part.input, part.output) === "probe") phase = "probe";
		if (part.type === "tool-resume_probe" && part.state === "output-available" &&
			(part.output as { ok?: unknown } | undefined)?.ok === true) phase = "probe";
		// probe → plan only via a concluded probe_done,
		// plan → teach only via a valid nodeId-tagged question. Rejected
		// calls remain retry context and never represent posed teaching.
		if (
			phase === "probe" && part.type === "tool-probe_done" && part.state === "output-available" &&
			(part.output as { ok?: unknown } | null | undefined)?.ok !== false
		) {
			phase = "plan";
		}
		// plan → teach via the first nodeId-tagged quizzing CALL — quiz OR
		// explain, whichever mechanic the settings armed (both carry nodeId).
		if (
			phase === "plan" &&
			(part.type === "tool-quiz" || part.type === "tool-explain") &&
			taggedNodeId(part.input) && part.state !== "output-error" &&
			(part.output as { ok?: unknown } | null | undefined)?.ok !== false
		) {
			phase = "teach";
		}
	}
	return phase;
}

/**
 * WHERE inside the flipping message teaching begins (owner round 8,
 * 2026-10-05 — the stacked-dividers bug): plan→teach flips at the first
 * tagged quiz/explain CALL, but the plan PRESENTATION often lives in the
 * same assistant message — an earlier provider STEP than the quiz call.
 * A message-level seam therefore drew the Teaching divider before the
 * plan presentation too (Planning and Teaching stacked back-to-back).
 * This returns the part index of the STEP BOUNDARY governing the flip
 * call: -1 when the call sits in the message's FIRST step (the divider
 * belongs before the whole message), else the index of the step-start
 * part whose generation contains the call — the divider renders there,
 * between the plan presentation and the teaching block.
 */
export function teachStepIndex(
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>,
): number {
	let stepStarts = 0; // how many step-start parts seen so far
	let latest = -1; // index of the latest step-start
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part.type === "step-start") {
			stepStarts++;
			latest = i;
			continue;
		}
		if (
			(part.type === "tool-quiz" || part.type === "tool-explain") &&
			taggedNodeId(part.input) && part.state !== "output-error" &&
			(part.output as { ok?: unknown } | null | undefined)?.ok !== false
		) {
			// The call's governing step: 0–1 step-starts seen = the message's
			// FIRST step → -1 (the divider belongs before the whole message);
			// a later step → that step-start's index (the divider renders at
			// the boundary, replacing the plain hairline there).
			return stepStarts <= 1 ? -1 : latest;
		}
	}
	return -1;
}

/**
 * The phase at EVERY message index, in one forward fold — the transcript
 * dividers render one per boundary, so phaseAt3(m, i) per index would rescan
 * 0..i each time (quadratic); this is the same derivation, linear.
 * out[i] === phaseAt3(messages, i) for every i.
 */
export function phaseTimeline(messages: readonly PhaseMessage[]): Phase3[] {
	const out: Phase3[] = [];
	let phase: Phase3 = "probe";
	for (let i = 0; i < messages.length; i++) {
		phase = advance(phase, messages[i]?.parts);
		out.push(phase);
	}
	return out;
}

// ─── the native fold (Wave D: record-side phase over LhMessage[]) ───────────

import { planReviewResults, probeDoneResultIds, successfulToolResultIds, type LhMessage } from "./native-messages.ts";

/** The phase at `upToIndex` (inclusive; default: the last message) of a
 *  NATIVE record. probe→plan advances at the probe_done call's clean
 *  toolResult; plan→teach at the assistant message carrying the first
 *  nodeId-tagged quiz CALL (mirrors the view fold — same seam, native
 *  shape). */
export function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	const concluded = probeDoneResultIds(messages.slice(0, last + 1));
	const resumed = successfulToolResultIds(messages.slice(0, last + 1), "resume_probe");
	const reviews = planReviewResults(messages.slice(0, last + 1));
	// Results project back onto their calls in the client. Match that rule
	// even when asking for the phase at an earlier message index.
	const rejected = new Set(messages.flatMap((m) =>
		m.role === "toolResult" && (m.isError || (m.details as { ok?: unknown } | undefined)?.ok === false)
			? [m.toolCallId] : [],
	));
	for (let i = 0; i <= last; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "toolResult") {
			if (resumed.has(m.id) || reviews.get(m.id) === "probe") phase = "probe";
			if (phase === "probe" && concluded.has(m.id)) phase = "plan";
		} else if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			const content = (m as { content?: ReadonlyArray<{ type?: string; name?: string; id?: string; arguments?: unknown }> }).content ?? [];
			if (phase === "plan") {
				for (const block of content) {
					if (
						block.type === "toolCall" &&
						(block.name === "quiz" || block.name === "explain") &&
						taggedNodeId(block.arguments) && !rejected.has(block.id ?? "")
					) {
						phase = "teach";
						break;
					}
				}
			}
		}
	}
	return phase;
}

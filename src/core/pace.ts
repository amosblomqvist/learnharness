import type { ChatRecord, CourseLesson, LessonMinutes, PaceStats } from "./contracts.ts";
import { answeredResultIndex, localDate, taggedCalls } from "./course-progress.ts";
import type { LhMessage } from "./native-messages.ts";
import { phaseAt3Lh } from "./phases.ts";

/**
 * The learner's PACE, learned from past sessions (courses plan,
 * 2026-10-30, owner-decided constants). Pure, browser-safe.
 *
 * Active time: the sum of gaps between consecutive message timestamps,
 * where a gap longer than IDLE_GAP_MS is a break and contributes 0.
 *
 * Samples come from every TEACH session (practice excluded) that reached
 * the teach phase:
 *   overhead — active time from the first message to the assistant message
 *              carrying the first nodeId-tagged quiz/explain call (probe +
 *              plan);
 *   node     — per plan node, the active time of each RUN on it (from the
 *              message with the run's first tagged call to the message with
 *              the next distinct node's first tagged call; the final run
 *              ends at the latest tagged call's answered result and is
 *              dropped while unanswered), revisits summed per node.
 *
 * Cold start blends toward defaults: pace = (D·W + Σ measured) / (W + n).
 * Cadence (weekly minutes, study days) folds ALL sessions' active time
 * over the last 28 days — practice is study time too.
 */

export const IDLE_GAP_MS = 10 * 60_000;
export const NODE_DEFAULT_MINUTES = 8;
export const NODE_PRIOR_WEIGHT = 10;
export const OVERHEAD_DEFAULT_MINUTES = 10;
export const OVERHEAD_PRIOR_WEIGHT = 5;
const CADENCE_DAYS = 28;

/** Active milliseconds between message indices `from` and `to` (inclusive). */
function activeBetween(messages: readonly LhMessage[], from: number, to: number): number {
	let ms = 0;
	for (let i = from + 1; i <= to; i++) {
		const gap = messages[i]!.timestamp - messages[i - 1]!.timestamp;
		if (gap > 0 && gap <= IDLE_GAP_MS) ms += gap;
	}
	return ms;
}

/** Active milliseconds over a whole timestamp sequence. */
export function activeMs(timestamps: readonly number[]): number {
	let ms = 0;
	for (let i = 1; i < timestamps.length; i++) {
		const gap = timestamps[i]! - timestamps[i - 1]!;
		if (gap > 0 && gap <= IDLE_GAP_MS) ms += gap;
	}
	return ms;
}

export interface SessionPaceSamples {
	overheadMinutes: number;
	/** One entry per measured plan node (revisits summed). */
	nodeMinutes: number[];
}

/** A session's pace samples, or null when it never reached teaching. */
export function sessionPaceSamples(record: Pick<ChatRecord, "kind" | "tree" | "messages">): SessionPaceSamples | null {
	if (record.kind === "practice" || !record.tree || record.tree.nodes.length === 0) return null;
	const messages = record.messages;
	if (messages.length === 0 || phaseAt3Lh(messages) !== "teach") return null;
	const ids = new Set(record.tree.nodes.map((n) => n.id));
	const calls = taggedCalls(messages).filter((c) => ids.has(c.nodeId));
	if (calls.length === 0) return null;

	const runs: Array<{ nodeId: string; start: number }> = [];
	for (const c of calls) if (runs.at(-1)?.nodeId !== c.nodeId) runs.push({ nodeId: c.nodeId, start: c.index });

	const perNode = new Map<string, number>();
	runs.forEach((run, k) => {
		let end: number | null;
		if (k + 1 < runs.length) end = runs[k + 1]!.start;
		else end = answeredResultIndex(messages, calls.at(-1)!.callId);
		if (end === null) return; // the open final run — not a finished measurement
		perNode.set(run.nodeId, (perNode.get(run.nodeId) ?? 0) + activeBetween(messages, run.start, end));
	});

	return {
		overheadMinutes: activeBetween(messages, 0, calls[0]!.index) / 60_000,
		nodeMinutes: [...perNode.values()].map((ms) => ms / 60_000),
	};
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Fold every session into blended PaceStats. `now` pins the cadence window. */
export function computePace(records: ReadonlyArray<Pick<ChatRecord, "kind" | "tree" | "messages">>, now: Date = new Date()): PaceStats {
	const nodes: number[] = [];
	const overheads: number[] = [];
	for (const r of records) {
		const s = sessionPaceSamples(r);
		if (!s) continue;
		overheads.push(s.overheadMinutes);
		nodes.push(...s.nodeMinutes);
	}
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

	const windowStart = now.getTime() - CADENCE_DAYS * 86_400_000;
	let cadenceMs = 0;
	const days = new Set<string>();
	for (const r of records) {
		const m = r.messages;
		for (let i = 1; i < m.length; i++) {
			const t = m[i]!.timestamp;
			if (t < windowStart || t > now.getTime()) continue;
			const gap = t - m[i - 1]!.timestamp;
			if (gap > 0 && gap <= IDLE_GAP_MS) {
				cadenceMs += gap;
				days.add(localDate(new Date(t)));
			}
		}
	}
	const weeks = CADENCE_DAYS / 7;

	return {
		nodeMinutes: round1((NODE_DEFAULT_MINUTES * NODE_PRIOR_WEIGHT + sum(nodes)) / (NODE_PRIOR_WEIGHT + nodes.length)),
		overheadMinutes: round1((OVERHEAD_DEFAULT_MINUTES * OVERHEAD_PRIOR_WEIGHT + sum(overheads)) / (OVERHEAD_PRIOR_WEIGHT + overheads.length)),
		measuredNodes: nodes.length,
		measuredSessions: overheads.length,
		weeklyMinutes: Math.round(cadenceMs / 60_000 / weeks),
		studyDaysPerWeek: round1(days.size / weeks),
		computedAt: now.toISOString(),
	};
}

/** A lesson's estimate: (overhead + nodes × pace) × multiplier, rounded. */
export function lessonMinutes(lesson: Pick<CourseLesson, "predictedNodes" | "multiplier" | "multiplierReason">, pace: PaceStats): LessonMinutes {
	const baseline = pace.overheadMinutes + lesson.predictedNodes * pace.nodeMinutes;
	return {
		overheadMinutes: pace.overheadMinutes,
		nodeMinutes: pace.nodeMinutes,
		predictedNodes: lesson.predictedNodes,
		baselineMinutes: Math.round(baseline),
		multiplier: lesson.multiplier,
		...(lesson.multiplierReason ? { multiplierReason: lesson.multiplierReason } : {}),
		minutes: Math.round(baseline * lesson.multiplier),
	};
}

/** The pace digest line shown to the learner and the planner. */
export function paceLine(pace: PaceStats): string {
	const history =
		pace.measuredNodes === 0
			? "default pace — no teaching history yet"
			: `from ${pace.measuredNodes} node${pace.measuredNodes === 1 ? "" : "s"} across ${pace.measuredSessions} session${pace.measuredSessions === 1 ? "" : "s"}; blended with defaults`;
	return `~${pace.nodeMinutes} min/node · ~${pace.overheadMinutes} min probing (${history})`;
}

/** The tooltip breakdown: "3 nodes × 7 + 12 = 33 min × 1.3 (reason) ≈ 43 min". */
export function lessonMinutesBreakdown(m: LessonMinutes): string {
	const base = `${m.predictedNodes} node${m.predictedNodes === 1 ? "" : "s"} × ${m.nodeMinutes} + ${m.overheadMinutes} = ${m.baselineMinutes} min`;
	if (m.multiplier === 1) return base;
	return `${base} × ${m.multiplier}${m.multiplierReason ? ` (${m.multiplierReason})` : ""} ≈ ${m.minutes} min`;
}

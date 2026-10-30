import type { ChatRecord, CourseHealth, CourseLesson, LessonStatus } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";

/**
 * Course progress — DERIVED, never stored (courses plan, 2026-10-30; the
 * plan tree's "no done ledger" law extended to courses). A lesson is done
 * when ANY of its linked sessions is done; a session is done when:
 *
 *   1. it has a plan tree with ≥ 1 node,
 *   2. EVERY node of the current tree appears in ≥ 1 nodeId-tagged
 *      quiz/explain CALL (the same signal derivePlanStatusesLh folds), and
 *   3. the MOST RECENT tagged call has been answered — a clean tool result
 *      (not an error, not dismissed) exists for it.
 *
 * (3) exists because derivePlanStatuses never marks the final node
 * "visited" — it stays "current" — and the lesson must not flip to done
 * the moment its last question is merely posed. Pure, browser-safe.
 */

interface TaggedCall {
	callId: string;
	nodeId: string;
	/** Index of the assistant message carrying the call. */
	index: number;
}

/** Every nodeId-tagged quiz/explain call in record order. */
export function taggedCalls(messages: readonly LhMessage[]): TaggedCall[] {
	const out: TaggedCall[] = [];
	messages.forEach((m, index) => {
		if (m.role !== "assistant") return;
		for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
			const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || nodeId.length === 0 || typeof block.id !== "string") continue;
			out.push({ callId: block.id, nodeId, index });
		}
	});
	return out;
}

/** The answered tool result for a call, or null (missing, errored, dismissed). */
export function answeredResultIndex(messages: readonly LhMessage[], callId: string): number | null {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.toolCallId !== callId) continue;
		if (m.isError) return null;
		if ((m.details as { dismissed?: boolean } | undefined)?.dismissed) return null;
		return i;
	}
	return null;
}

export function sessionDone(record: Pick<ChatRecord, "kind" | "tree" | "messages">): boolean {
	if (record.kind === "practice") return false;
	const tree = record.tree;
	if (!tree || tree.nodes.length === 0) return false;
	const ids = new Set(tree.nodes.map((n) => n.id));
	const calls = taggedCalls(record.messages).filter((c) => ids.has(c.nodeId));
	const reached = new Set(calls.map((c) => c.nodeId));
	if (reached.size < ids.size) return false;
	const last = calls.at(-1);
	return last !== undefined && answeredResultIndex(record.messages, last.callId) !== null;
}

/** A lesson's status over its linked sessions (deleted sessions are absent from `chats`). */
export function lessonStatus(
	lesson: Pick<CourseLesson, "sessionIds">,
	chats: ReadonlyMap<string, Pick<ChatRecord, "kind" | "tree" | "messages">>,
): LessonStatus {
	const linked = lesson.sessionIds.map((id) => chats.get(id)).filter((c) => c !== undefined);
	if (linked.some(sessionDone)) return "done";
	return linked.length > 0 ? "in-progress" : "not-started";
}

/** Past its target date and not done. `today` is YYYY-MM-DD. */
export function lessonOverdue(lesson: Pick<CourseLesson, "targetDate">, status: LessonStatus, today: string): boolean {
	return status !== "done" && lesson.targetDate < today;
}

export function courseHealth(overdue: readonly boolean[]): CourseHealth {
	return overdue.some(Boolean) ? "behind" : "on-track";
}

/** YYYY-MM-DD in the runtime's local time zone. */
export function localDate(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

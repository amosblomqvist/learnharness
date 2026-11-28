/**
 * Open gaps — what earlier teaching sessions left unresolved, derived
 * from the records themselves (no separate store). Per plan node, the
 * LAST graded check answer decides: a miss, an "I don't know", or a
 * hesitant correct pick is open; a later clean pass on the same node
 * (a repair's retest, the closing's retest) closes it. Predictions never
 * count — they are guesses by design.
 *
 * ponytail: multiple-choice `quiz` checks carry a machine verdict
 * (`correct`); free-recall `explain` answers are graded in the teacher's
 * prose, so only their "I don't know" counts here. Plugin questions are
 * skipped. Add a recorded verdict for free recall if those sessions need
 * gap tracking too.
 */

import type { ChatRecord } from "./contracts/chat.ts";
import type { LhMessage } from "./native-messages.ts";
import { normalizeQuizType, type QuestionAnswerData } from "./question-core.ts";

export type GapStatus = "missed" | "confident-miss" | "dont-know" | "fragile";

export interface OpenGap {
	nodeId: string;
	nodeTitle: string;
	status: GapStatus;
	question: string;
	confidence?: number;
	answeredAt: string;
}

export interface SessionGaps {
	chatId: string;
	title: string;
	updatedAt: string;
	gaps: OpenGap[];
}

/** Confidence at/above this on a miss = a confidently held wrong model. */
export const CONFIDENT_MISS = 70;
/** Confidence at/below this on a correct pick = fragile (possibly lucky). */
export const HESITANT_HIT = 30;

const CHECK_TOOLS = new Set(["quiz", "explain"]);

/** One session's open gaps, in node order of last answer. */
export function sessionOpenGaps(record: Pick<ChatRecord, "messages" | "tree">): OpenGap[] {
	const calls = new Map<string, { nodeId: string }>();
	const last = new Map<string, OpenGap | null>();
	for (const m of record.messages as LhMessage[]) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
				if (block.type !== "toolCall" || !block.id || !CHECK_TOOLS.has(block.name ?? "")) continue;
				const input = block.arguments as { nodeId?: unknown; type?: unknown } | undefined;
				if (typeof input?.nodeId !== "string" || normalizeQuizType(input.type) === "predict") continue;
				calls.set(block.id, { nodeId: input.nodeId });
			}
		} else if (role === "toolResult") {
			const r = m as { toolCallId?: string; details?: unknown; isError?: boolean };
			const call = r.toolCallId ? calls.get(r.toolCallId) : undefined;
			const answer = r.details as QuestionAnswerData | undefined;
			if (!call || r.isError || !answer || typeof answer !== "object" || answer.dismissed || !answer.answeredAt || answer.questionType === "predict") continue;
			const status = gapStatus(answer);
			if (status === undefined) continue; // ungraded (free recall): no evidence either way
			last.delete(call.nodeId); // re-insert: keeps last-answer order
			last.set(call.nodeId, status === null ? null : {
				nodeId: call.nodeId,
				nodeTitle: record.tree?.nodes.find((n) => n.id === call.nodeId)?.title ?? call.nodeId,
				status,
				question: answer.questionText,
				...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
				answeredAt: answer.answeredAt,
			});
		}
	}
	return [...last.values()].filter((g): g is OpenGap => g !== null);
}

/** null = a clean pass (closes the node); undefined = no verdict recorded. */
function gapStatus(a: QuestionAnswerData): GapStatus | null | undefined {
	if (a.dontKnow) return "dont-know";
	if (typeof a.correct !== "boolean") return undefined;
	if (!a.correct) return (a.confidence ?? 0) >= CONFIDENT_MISS ? "confident-miss" : "missed";
	return a.confidence !== undefined && a.confidence <= HESITANT_HIT ? "fragile" : null;
}

/** Every teaching session with open gaps, most recent first. */
export function openGaps(records: Iterable<ChatRecord>, opts: { excludeChatId?: string; limit?: number } = {}): SessionGaps[] {
	const out: SessionGaps[] = [];
	for (const r of records) {
		if (r.kind === "practice" || r.id === opts.excludeChatId) continue;
		const gaps = sessionOpenGaps(r);
		if (gaps.length) out.push({ chatId: r.id, title: r.title, updatedAt: r.updatedAt, gaps });
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return opts.limit ? out.slice(0, opts.limit) : out;
}

const STATUS_TEXT: Record<GapStatus, string> = {
	"confident-miss": "confident miss — a firmly held wrong model",
	missed: "missed",
	"dont-know": "didn't know",
	fragile: "correct but hesitant — fragile",
};

/** The tool's text rendering (model-facing, English like every tool text). */
export function formatOpenGaps(sessions: readonly SessionGaps[]): string {
	if (sessions.length === 0) return "No open gaps — every graded check in earlier teaching sessions ended on a clean pass.";
	const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s).replace(/\s+/g, " ");
	return sessions
		.map((s) => [
			`## ${s.title} (last active ${s.updatedAt.slice(0, 10)}, id ${s.chatId})`,
			...s.gaps.map((g) =>
				`- ${g.nodeTitle} [${g.nodeId}]: ${STATUS_TEXT[g.status]}${g.confidence !== undefined ? ` (confidence ${g.confidence})` : ""}, ${g.answeredAt.slice(0, 10)}\n  last check: ${clip(g.question)}`),
		].join("\n"))
		.join("\n\n");
}

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	ERROR_TYPES,
	ERROR_TYPE_LABELS,
	patternLine,
	summarizeMistakes,
	type MistakeRecord,
} from "../../core/mistakes.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";

/**
 * mistakes — the learner's recorded mistake history, READ-ONLY.
 *
 * The tracker already writes the records (core/mistakes.ts + store/mistakes.ts);
 * this tool is the model-facing way to read them without being handed an
 * OS-specific data path or parsing raw JSON. It never writes, rescans a
 * session, or generates an analysis.
 */

export const MISTAKES_TOOL = "mistakes";

/** Injected by the composition root; the agent layer never imports the store. */
export interface MistakeToolContext {
	read: () => readonly MistakeRecord[];
}
const DEFAULT_LIMIT = 8;
/** Hard cap on records in one list response (the token budget). */
export const MAX_MISTAKES_LIMIT = 40;

const oneLine = (value: unknown, max: number): string =>
	typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Known labels, else the raw stored slug; never the word "undefined". */
function errorTypeLabel(type: unknown): string {
	if (typeof type !== "string" || !type) return "Unknown error type";
	return (ERROR_TYPE_LABELS as Record<string, string>)[type] ?? type;
}

const errorTypeSchema = Type.Union(
	ERROR_TYPES.map((type) => Type.Literal(type)),
	{ description: "Only this analyzed error type." },
);

const mistakesInput = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("list"), Type.Literal("summary"), Type.Literal("get")], {
			description: "list recent or filtered mistakes; summary counts and recurring patterns; get one record by id. Defaults to list.",
		}),
	),
	id: Type.Optional(Type.String({ description: "get only: the mistake id shown by a list result." })),
	session: Type.Optional(Type.String({ description: "Only mistakes from sessions whose id or title contains this text." })),
	chatId: Type.Optional(Type.String({ description: "Only mistakes from this exact session id." })),
	errorType: Type.Optional(errorTypeSchema),
	status: Type.Optional(
		Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")], {
			description: "Only mistakes whose analysis is pending, ready, or failed.",
		}),
	),
	topic: Type.Optional(Type.String({ description: "Only analyzed mistakes whose topic contains this text." })),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_MISTAKES_LIMIT,
			description: `list: maximum records to show (default ${DEFAULT_LIMIT}, hard max ${MAX_MISTAKES_LIMIT}).`,
		}),
	),
});
type MistakesInput = Static<typeof mistakesInput>;

function filterRecords(records: readonly MistakeRecord[], input: MistakesInput): MistakeRecord[] {
	const session = input.session?.trim().toLowerCase() ?? "";
	const topic = input.topic?.trim().toLowerCase() ?? "";
	return records.filter((record) => {
		if (input.chatId && record.chatId !== input.chatId) return false;
		if (session) {
			const title = typeof record.sessionTitle === "string" ? record.sessionTitle : "";
			if (!record.chatId.toLowerCase().includes(session) && !title.toLowerCase().includes(session)) return false;
		}
		if (input.errorType && record.analysis?.errorType !== input.errorType) return false;
		if (input.status && record.status !== input.status) return false;
		if (topic) {
			const analysisTopic = typeof record.analysis?.topic === "string" ? record.analysis.topic : "";
			if (!analysisTopic.toLowerCase().includes(topic)) return false;
		}
		return true;
	});
}

function newestFirst(records: readonly MistakeRecord[]): MistakeRecord[] {
	const when = (record: MistakeRecord) =>
		typeof record.createdAt === "string" ? record.createdAt : typeof record.answeredAt === "string" ? record.answeredAt : "";
	return [...records].sort((a, b) => when(b).localeCompare(when(a)) || a.id.localeCompare(b.id));
}

function analysisLabel(record: MistakeRecord): string {
	if (record.analysis) return errorTypeLabel(record.analysis.errorType);
	if (record.status === "pending") return "Analysis pending";
	if (record.status === "failed") return "Analysis failed";
	return "Not analyzed";
}

function listText(records: readonly MistakeRecord[], input: MistakesInput): string {
	const matched = newestFirst(filterRecords(records, input));
	if (matched.length === 0) return records.length === 0 ? "No mistakes have been recorded yet." : "No mistakes match those filters.";
	const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : DEFAULT_LIMIT;
	const limit = Math.min(MAX_MISTAKES_LIMIT, Math.max(1, requested));
	const shown = matched.slice(0, limit);
	const suffix = matched.length > shown.length ? ` (showing ${shown.length})` : "";
	const heading = `${matched.length} ${matched.length === 1 ? "mistake" : "mistakes"} found${suffix}:`;
	const lines = [heading];
	for (const record of shown) {
		const topicLabel = oneLine(record.analysis?.topic, 80);
		const topic = topicLabel ? ` · ${topicLabel}` : "";
		const session = oneLine(record.sessionTitle, 80) || "Untitled session";
		const kind = oneLine(record.kind, 40) || "mistake";
		lines.push(
			`- ${record.id} · ${kind} · ${analysisLabel(record)}${topic} · ${session}: ${oneLine(record.question, 160)}`,
		);
	}
	if (matched.length > shown.length) {
		lines.push(`${matched.length - shown.length} more not shown; narrow the filters or raise limit (max ${MAX_MISTAKES_LIMIT}).`);
	}
	return lines.join("\n");
}

function summaryText(records: readonly MistakeRecord[], input: MistakesInput): string {
	const matched = filterRecords(records, input);
	if (matched.length === 0) return records.length === 0 ? "No mistakes have been recorded yet." : "No mistakes match those filters.";
	const summary = summarizeMistakes(matched);
	let ready = 0;
	let failed = 0;
	for (const record of matched) {
		if (record.status === "ready") ready += 1;
		else if (record.status === "failed") failed += 1;
	}
	const lines = [
		`Mistakes: ${summary.total} total — ${summary.missed} missed, ${summary.unanswered} unanswered, ${summary.problems} ${summary.problems === 1 ? "problem" : "problems"}.`,
		`Analysis: ${ready} ready, ${failed} failed, ${summary.pending} pending.`,
	];
	if (summary.byType.length > 0) {
		lines.push("By error type:");
		for (const { type, count } of summary.byType) lines.push(`- ${errorTypeLabel(type)}: ${count}`);
	}
	const patterns = [patternLine(matched, "errorType"), patternLine(matched, "topic")].filter((line): line is string => line !== null);
	if (patterns.length > 0) {
		lines.push("Recurring patterns:");
		for (const pattern of patterns) lines.push(`- ${pattern}`);
	}
	return lines.join("\n");
}

function getText(records: readonly MistakeRecord[], id: string): string {
	const record = records.find((candidate) => candidate.id === id);
	if (!record) return `No mistake with id "${id}". Use action list to see available ids.`;
	const session = oneLine(record.sessionTitle, 160) || "Untitled session";
	const sessionKind = oneLine(record.sessionKind, 40) || "session";
	const status = oneLine(record.status, 40) || "unknown status";
	const kind = oneLine(record.kind, 40) || "mistake";
	const recorded = typeof record.createdAt === "string" && record.createdAt ? ` · ${record.createdAt.slice(0, 10)}` : "";
	const lines = [
		`Mistake ${record.id}`,
		`Session: ${session} (${sessionKind})`,
		`Status: ${status} · ${kind}${recorded}`,
		`Question: ${oneLine(record.question, 600)}`,
		`Your answer: ${oneLine(record.yourAnswer, 300)}`,
		`Correct answer: ${oneLine(record.correctAnswer, 300)}`,
	];
	if (record.analysis) {
		lines.push(
			`Error type: ${errorTypeLabel(record.analysis.errorType)}`,
			`Topic: ${oneLine(record.analysis.topic, 120)}`,
			`What went wrong: ${oneLine(record.analysis.whatYouDid, 700)}`,
			`Correct reasoning: ${oneLine(record.analysis.correct, 700)}`,
			`Rule for next time: ${oneLine(record.analysis.rule, 400)}`,
		);
	} else if (record.status === "pending") {
		lines.push("Analysis: pending.");
	} else if (record.status === "failed") {
		lines.push("Analysis: failed; the record above is still available.");
	}
	if (record.outcome) lines.push(`Outcome: ${oneLine(record.outcome, 120)}`);
	if (record.verdict) lines.push(`Verdict: ${oneLine(record.verdict, 300)}`);
	if (record.thinking) lines.push(`Your thinking: ${oneLine(record.thinking, 400)}`);
	if (typeof record.confidence === "number") lines.push(`Confidence: ${record.confidence}%`);
	return lines.join("\n");
}

export function mistakeTools(ctx: MistakeToolContext): Record<string, AgentTool<any>> {
	const tool: AgentTool<typeof mistakesInput> = {
		name: MISTAKES_TOOL,
		label: MISTAKES_TOOL,
		description:
			"Read the learner's recorded mistake history. List recent or filtered mistakes, summarize counts and recurring error patterns, or get one record by id. " +
			"Read-only: it never writes, rescans, or generates analysis. Use it to ground repair; never ask the learner to open or export a data file.",
		parameters: mistakesInput,
		execute: async (_callId, raw) => {
			const input = raw as MistakesInput;
			const records = ctx.read();
			const action = input.action ?? "list";
			if (action === "get") {
				const id = input.id?.trim();
				if (!id) return invalidInputResult(MISTAKES_TOOL, ["get needs an id from a list result"]);
				return toToolResult(getText(records, id));
			}
			if (action === "summary") return toToolResult(summaryText(records, input));
			return toToolResult(listText(records, input));
		},
	};
	return { [MISTAKES_TOOL]: tool };
}

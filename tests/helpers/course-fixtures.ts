/**
 * Course test fixtures — tiny native-record builders for the course folds
 * (course-progress, pace). Only the fields the folds read are populated.
 */
import type { ChatRecord, CourseLesson, PlanTree } from "../../src/core/contracts.ts";
import type { LhMessage } from "../../src/core/native-messages.ts";

let seq = 0;
const id = (p: string) => `${p}_${++seq}`;

export function userMsg(t: number, text = "hi"): LhMessage {
	return { id: id("u"), role: "user", content: text, timestamp: t } as LhMessage;
}

export function callMsg(t: number, name: string, args: Record<string, unknown>, callId = id("call")): LhMessage {
	return {
		id: id("a"),
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: t,
	} as unknown as LhMessage;
}

export function resultMsg(t: number, callId: string, name: string, extra: { isError?: boolean; details?: unknown } = {}): LhMessage {
	return {
		id: id("r"),
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: extra.isError ?? false,
		details: extra.details ?? { ok: true },
		timestamp: t,
	} as unknown as LhMessage;
}

export const MIN = 60_000;

export function tree(...ids: string[]): PlanTree {
	return { nodes: ids.map((n) => ({ id: n, title: n })), edges: [], version: 1 };
}

/** A teach session: probe (overhead span), then each [nodeId, minutes]
 *  as a quiz call answered after `minutes`. Times are in minutes from t0. */
export function teachSession(opts: {
	t0?: number;
	probeMinutes: number;
	nodes: Array<[string, number]>;
	answerLast?: boolean;
	treeIds?: string[];
}): Pick<ChatRecord, "kind" | "tree" | "messages"> {
	const t0 = opts.t0 ?? Date.UTC(2026, 9, 1, 12);
	let t = t0;
	const messages: LhMessage[] = [userMsg(t)];
	t += opts.probeMinutes * MIN;
	const probeCall = id("probe");
	messages.push(callMsg(t, "probe_done", {}, probeCall), resultMsg(t, probeCall, "probe_done"));
	opts.nodes.forEach(([nodeId, minutes], i) => {
		const callId = id("quiz");
		messages.push(callMsg(t, "quiz", { nodeId }, callId));
		t += minutes * MIN;
		const last = i === opts.nodes.length - 1;
		if (!last || opts.answerLast !== false) messages.push(resultMsg(t, callId, "quiz", { details: {} }));
	});
	return { tree: tree(...(opts.treeIds ?? [...new Set(opts.nodes.map(([n]) => n))])), messages };
}

export function lesson(fields: Partial<CourseLesson> & { id: string }): CourseLesson {
	return {
		title: fields.id,
		goal: `goal ${fields.id}`,
		guideSummary: `summary ${fields.id}`,
		prerequisites: [],
		targetDate: "2026-11-10",
		predictedNodes: 3,
		multiplier: 1,
		sessionIds: [],
		...fields,
	};
}

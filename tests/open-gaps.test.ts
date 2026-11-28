import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatOpenGaps, openGaps, sessionOpenGaps } from "../src/core/open-gaps.ts";
import type { ChatRecord } from "../src/core/contracts.ts";

let n = 0;
const call = (name: string, args: Record<string, unknown>) => {
	const id = `call_${++n}`;
	return { id, msg: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } };
};
const answer = (toolCallId: string, a: Record<string, unknown>) => ({
	role: "toolResult", toolCallId, toolName: "quiz", isError: false,
	details: { kind: "quiz", questionText: `q for ${toolCallId}`, dontKnow: false, answers: [], answeredAt: "2026-11-20T10:00:00Z", ...a },
});
/** One check on `nodeId` answered with `a`. */
const check = (nodeId: string, a: Record<string, unknown>, extra: Record<string, unknown> = {}, tool = "quiz") => {
	const c = call(tool, { nodeId, type: "check", ...extra });
	return [c.msg, answer(c.id, a)];
};
const record = (id: string, messages: unknown[], over: Partial<ChatRecord> = {}): ChatRecord => ({
	id, title: `Session ${id}`, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-20T10:00:00Z",
	messages: messages as ChatRecord["messages"],
	tree: { nodes: [{ id: "a", title: "Node A" }, { id: "b", title: "Node B" }, { id: "c", title: "Node C" }], edges: [], version: 1 },
	...over,
});

describe("open gaps", () => {
	it("classifies the last graded answer per node", () => {
		const gaps = sessionOpenGaps(record("x", [
			...check("a", { correct: false, confidence: 90 }),
			...check("b", { correct: false, confidence: 50 }),
			...check("c", { correct: true, confidence: 30 }),
		]));
		assert.deepEqual(gaps.map((g) => [g.nodeId, g.status, g.nodeTitle]), [
			["a", "confident-miss", "Node A"], ["b", "missed", "Node B"], ["c", "fragile", "Node C"],
		]);
	});

	it("a later clean pass closes the gap; a later miss reopens it", () => {
		const gaps = sessionOpenGaps(record("x", [
			...check("a", { correct: false, confidence: 90 }),
			...check("a", { correct: true, confidence: 80 }),
			...check("b", { correct: true, confidence: 80 }),
			...check("b", { dontKnow: true }),
		]));
		assert.deepEqual(gaps.map((g) => [g.nodeId, g.status]), [["b", "dont-know"]]);
	});

	it("ignores predictions, untagged calls, dismissals, ungraded free recall", () => {
		const gaps = sessionOpenGaps(record("x", [
			...check("a", { correct: false }, { type: "predict" }),
			...check("b", { correct: false, dismissed: true }),
			...check("c", { kind: "explain", text: "my words" }, {}, "explain"),
		]));
		assert.deepEqual(gaps, []);
		// free recall "I don't know" is a gap
		assert.equal(sessionOpenGaps(record("y", check("c", { kind: "explain", dontKnow: true }, {}, "explain")))[0]?.status, "dont-know");
	});

	it("skips practice sessions and the calling chat, newest first, formatted", () => {
		const miss = () => check("a", { correct: false, confidence: 75 });
		const sessions = openGaps([
			record("old", miss(), { updatedAt: "2026-11-01T00:00:00Z" }),
			record("new", miss(), { updatedAt: "2026-11-25T00:00:00Z" }),
			record("prac", miss(), { kind: "practice" }),
			record("self", miss()),
		], { excludeChatId: "self" });
		assert.deepEqual(sessions.map((s) => s.chatId), ["new", "old"]);
		const text = formatOpenGaps(sessions);
		assert.match(text, /## Session new/);
		assert.match(text, /Node A \[a\]: confident miss.*\(confidence 75\)/);
		assert.match(formatOpenGaps([]), /No open gaps/);
	});
});

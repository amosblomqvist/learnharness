/**
 * RETRY THE AGENT'S LAST MESSAGE (#122) — the pure core: regenerateCut
 * (where the agent span begins), regenerateRefusal (the compaction guard)
 * and the regenerate input event's parse. Deterministic, no LLM.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { parseChatInput, ChatInputError } from "../src/core/input-events.ts";
import {
	concludedByDismissalPair,
	newAnswerResult,
	newGraphContextMessage,
	newNextMessage,
	newPlanBlockMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	regenerateCut,
	regenerateRefusal,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { newCompactionMarker, projectView } from "../src/core/index.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { dismissedAnswer } from "../src/core/question-core.ts";

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
} as const;

let seq = 0;
const id = () => `m${seq++}`;

function user(text = "hi"): LhMessage {
	return { id: id(), role: "user", content: text, timestamp: 1 };
}
function text(t = "reply"): LhMessage {
	return { id: id(), role: "assistant", content: [{ type: "text", text: t }], timestamp: 1, stopReason: "stop", ...STAMPS } as LhMessage &
		AssistantMessage;
}
function call(callId: string, name: string): LhMessage {
	return {
		id: id(),
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: {} }],
		timestamp: 1,
		stopReason: "toolUse",
		...STAMPS,
	} as LhMessage & AssistantMessage;
}
function result(callId: string, name: string): LhMessage {
	return {
		id: id(),
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details: null,
		isError: false,
		timestamp: 1,
	} as LhMessage & ToolResultMessage;
}
function answer(callId: string, dismissed = false): LhMessage {
	const a = dismissed
		? dismissedAnswer("quiz", "Q?")
		: { kind: "quiz", questionText: "Q?", answers: [], dontKnow: false, answeredAt: new Date().toISOString() };
	return newAnswerResult(callId, "quiz", a);
}

describe("regenerateCut (the agent span after the last learner input)", () => {
	it("a plain reply: the cut sits right after the user message", () => {
		const m = [user(), text()];
		assert.equal(regenerateCut(m), 1);
	});

	it("a multi-record tool span (calls + results + text) is ONE span", () => {
		const m = [user("a"), text("old"), user("b"), call("c1", "research"), result("c1", "research"), call("c2", "demo"), result("c2", "demo"), text()];
		assert.equal(regenerateCut(m), 3);
	});

	it("a pending quiz at the end rides inside the span (the question goes with it)", () => {
		const m = [user(), text("intro"), call("q1", "quiz")];
		assert.equal(regenerateCut(m), 1);
	});

	it("an answered quiz's result is the boundary: only the reaction is discarded", () => {
		const m = [user(), call("q1", "quiz"), answer("q1"), text("reaction")];
		assert.equal(regenerateCut(m), 3);
	});

	it("a dismissal result is a boundary too (never delete the learner's choice)", () => {
		const m = [user(), call("q1", "quiz"), answer("q1", true)];
		assert.equal(regenerateCut(m), m.length, "empty span: nothing is cut");
	});

	it("steer and wake markers are boundaries", () => {
		const steer = buildSubagentSteer(
			{ id: "job1", kind: "research", toolCallId: "c1" },
			{ brief: "b", sources: [] } as never,
		) as unknown as LhMessage;
		const m = [user(), text("a"), steer, text("woven")];
		assert.equal(regenerateCut(m), 3);
	});

	it("an empty span reruns from the input: the cut is messages.length", () => {
		const m = [user(), text("a"), user("b")];
		assert.equal(regenerateCut(m), m.length);
	});

	it("practice boundaries: thinking and next markers start a span; a problem's ack does not", () => {
		const thinking = newThinkingMessage("p1", "my working") as unknown as LhMessage;
		const next = newNextMessage() as unknown as LhMessage;
		const afterThinking = [user(), call("p1", "problem"), result("p1", "problem"), thinking, text("feedback")];
		assert.equal(regenerateCut(afterThinking), 4);
		const afterNext = [user(), text("a"), next, call("p2", "problem"), result("p2", "problem")];
		assert.equal(regenerateCut(afterNext), 3, "the pose + its ack are the span");
	});

	it("graph-context is a boundary (it flattens to a user message and breaks the view group)", () => {
		const ctx = newGraphContextMessage([{ id: "n1", name: "N", statement: "S" }], []) as unknown as LhMessage;
		assert.equal(regenerateCut([ctx, text()]), 1);
	});

	it("plan blocks and problem-dismissed markers ride inside the span", () => {
		const plan = newPlanBlockMessage("c1", {}) as unknown as LhMessage;
		const dismissed = newProblemDismissedMarker("p1") as unknown as LhMessage;
		assert.equal(regenerateCut([user(), call("c1", "plan_init"), result("c1", "plan_init"), plan]), 1);
		assert.equal(regenerateCut([user(), call("p1", "problem"), result("p1", "problem"), dismissed]), 1);
	});

	it("the synthesized dismissal-conclude pair sits BEFORE the next input, outside the new span", () => {
		const [a, r] = concludedByDismissalPair("p1") as unknown as LhMessage[];
		const m = [user(), call("p1", "problem"), result("p1", "problem"), a!, r!, user("next"), text("fresh")];
		assert.equal(regenerateCut(m), 6);
	});

	it("no boundary at all: -1 (nothing to rerun from)", () => {
		assert.equal(regenerateCut([]), -1);
		assert.equal(regenerateCut([text()]), -1);
	});

	it("the cut span equals the grouped view bubble (a user-role view message ends the group)", () => {
		const m = [user(), text("a"), call("c1", "research"), result("c1", "research"), text("b")];
		const full = projectView(m);
		assert.equal(full.length, 2);
		assert.equal(full[1]!.role, "assistant", "one grouped bubble");
		const base = projectView(m.slice(0, regenerateCut(m)));
		assert.equal(base.length, 1);
		assert.equal(base[0]!.role, "user", "cutting the span removes exactly that bubble");
	});
});

describe("regenerateRefusal (the compaction guard)", () => {
	it("a clean cut is allowed", () => {
		const m = [user(), text()];
		assert.equal(regenerateRefusal(m, regenerateCut(m)), null);
	});

	it("refuses when the span contains a compaction marker", () => {
		const first = user();
		const compaction = newCompactionMarker("summary", {
			firstKeptMessageId: first.id,
			tokensBefore: 1,
			at: new Date().toISOString(),
		}) as unknown as LhMessage;
		const m = [first, text(), compaction];
		assert.match(regenerateRefusal(m, regenerateCut(m)) ?? "", /compaction/);
	});

	it("refuses when the span holds the active marker's kept boundary", () => {
		const input = user();
		const reply = text();
		const compaction = newCompactionMarker("summary", {
			firstKeptMessageId: reply.id,
			tokensBefore: 1,
			at: new Date().toISOString(),
		}) as unknown as LhMessage;
		// The pointer check stands alone (the marker here sits past the span's end).
		const m = [input, reply, compaction];
		assert.match(regenerateRefusal(m, 1) ?? "", /compaction/);
	});

	it("a compaction BEFORE the last input does not block a retry", () => {
		const old = user("old");
		const compaction = newCompactionMarker("summary", {
			firstKeptMessageId: old.id,
			tokensBefore: 1,
			at: new Date().toISOString(),
		}) as unknown as LhMessage;
		const m = [old, text("x"), compaction, user("new"), text("reply")];
		assert.equal(regenerateRefusal(m, regenerateCut(m)), null);
	});

	it("refuses a partially answered parallel batch (a sibling question still dangles)", () => {
		const batch = {
			...call("q1", "quiz"),
			content: [
				{ type: "toolCall", id: "q1", name: "quiz", arguments: {} },
				{ type: "toolCall", id: "q2", name: "quiz", arguments: {} },
			],
		} as LhMessage;
		const partial = [user(), batch, answer("q1")];
		assert.equal(regenerateCut(partial), 3, "the answer is still the boundary");
		assert.match(regenerateRefusal(partial, regenerateCut(partial)) ?? "", /sibling question/);
		const full = [...partial, answer("q2")];
		assert.equal(regenerateRefusal(full, regenerateCut(full)), null, "a fully answered batch is fine");
	});

	it("a missing boundary (cut -1) is refused", () => {
		assert.match(regenerateRefusal([text()], -1) ?? "", /no learner input/);
	});
});

describe("the regenerate input event", () => {
	it("parses a message id and null (an empty record)", () => {
		assert.deepEqual(parseChatInput({ type: "regenerate", lastMessageId: "m1" }), { type: "regenerate", lastMessageId: "m1" });
		assert.deepEqual(parseChatInput({ type: "regenerate", lastMessageId: null }), { type: "regenerate", lastMessageId: null });
	});

	it("rejects a missing, empty or non-string lastMessageId with a ChatInputError", () => {
		for (const bad of [{}, { lastMessageId: "" }, { lastMessageId: 3 }]) {
			assert.throws(() => parseChatInput({ type: "regenerate", ...bad }), ChatInputError);
		}
	});
});

/**
 * Ask before the check: while a teach-phase check is the only open
 * question, the learner's message closes it as notYet and follows the
 * result. A sibling, a probe question, or a prediction is refused — a
 * user message must not land ahead of an unanswered call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { danglingQuestionCount, type LhMessage } from "../src/core/native-messages.ts";
import { askBeforeCheckVisible, pendingQuestionCount } from "../src/core/pending.ts";
import { notYetAnswer, compactAnswerForModel } from "../src/core/question-core.ts";
import { projectView } from "../src/core/view.ts";

function assistant(id: string, calls: { id: string; name: string; arguments: unknown }[]): LhMessage {
	return {
		id,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
		timestamp: 1,
	} as LhMessage;
}

function probeDone(): LhMessage {
	return {
		id: "pd",
		role: "toolResult",
		toolCallId: "probe-done",
		toolName: "probe_done",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	} as LhMessage;
}

const CHECK = { question: "What carries the tense?", type: "check", nodeId: "n1" };

function teachCheck(calls: { id: string; name?: string; arguments?: unknown }[] = [{ id: "c1" }]): LhMessage[] {
	return [
		probeDone(),
		assistant(
			"a1",
			calls.map((c) => ({
				id: c.id,
				name: c.name ?? "quiz",
				arguments: c.arguments ?? CHECK,
			})),
		),
	];
}

describe("notYetAnswer", () => {
	it("compacts to kind and notYet, with no verdict", () => {
		const ad = notYetAnswer("quiz", "What carries the tense?");
		assert.equal(ad.notYet, true);
		assert.equal(ad.dismissed, undefined);
		assert.equal(ad.dontKnow, false);
		assert.deepEqual(compactAnswerForModel(ad), { kind: "quiz", notYet: true });
	});
});

describe("ask-before-check appends", () => {
	it("closes the check, then appends his message", () => {
		const input = parseChatInput({ type: "ask-before-check", toolCallId: "c1", text: "why not to watched?" });
		const appends = inputAppends({ messages: teachCheck() }, input);
		assert.equal(appends.length, 2);
		const result = appends[0] as { role: string; toolCallId: string; content: { text: string }[] };
		assert.equal(result.role, "toolResult");
		assert.equal(result.toolCallId, "c1");
		assert.deepEqual(JSON.parse(result.content[0]!.text), { kind: "quiz", notYet: true });
		const user = appends[1] as { role: string; content: string };
		assert.equal(user.role, "user");
		assert.equal(user.content, "why not to watched?");
		assert.equal(danglingQuestionCount([...teachCheck(), ...appends]), 0);
	});

	it("refuses a sibling, a probe question, and a prediction", () => {
		assert.throws(
			() => inputAppends({ messages: teachCheck([{ id: "c1" }, { id: "c2" }]) }, { type: "ask-before-check", toolCallId: "c1", text: "huh?" }),
			/only open question/,
		);
		assert.throws(
			() => inputAppends({ messages: [assistant("a", [{ id: "c1", name: "quiz", arguments: { question: "Q?" } }])] }, { type: "ask-before-check", toolCallId: "c1", text: "huh?" }),
			/teach-phase check/,
		);
		assert.throws(
			() =>
				inputAppends(
					{ messages: teachCheck([{ id: "c1", arguments: { question: "Guess?", type: "predict", nodeId: "n1" } }]) },
					{ type: "ask-before-check", toolCallId: "c1", text: "huh?" },
				),
			/teach-phase check/,
		);
		assert.throws(
			() => inputAppends({ messages: [] }, { type: "ask-before-check", toolCallId: "c1", text: "huh?" }),
			/no pending/,
		);
		assert.throws(() => parseChatInput({ type: "ask-before-check", toolCallId: "c1", text: "  " }), /non-empty/);
	});
});

describe("ask composer gate", () => {
	it("shows only while one check is still closed", () => {
		assert.equal(askBeforeCheckVisible(true, 1), true);
		assert.equal(askBeforeCheckVisible(false, 1), false);
		assert.equal(askBeforeCheckVisible(true, 2), false);
		const view = projectView(teachCheck());
		assert.equal(pendingQuestionCount(view), 1);
		const two = projectView(teachCheck([{ id: "c1" }, { id: "c2" }]));
		assert.equal(pendingQuestionCount(two), 2);
	});
});

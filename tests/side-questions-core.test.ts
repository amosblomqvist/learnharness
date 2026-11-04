import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	SIDE_PASSAGE_MAX_CHARS,
	SIDE_QUESTION_MAX_CHARS,
	SIDE_THREAD_MAX_PAIRS,
	finalTell,
	newSideQuestionMarker,
	parseSideCloseInput,
	parseSideQuestionInput,
	sideTranscript,
	sideUserMessage,
} from "../src/core/side-questions.ts";
import { ChatInputError } from "../src/core/input-events.ts";
import { newAnswerResult, newHandoffMessage, newPlanBlockMessage, type LhMessage } from "../src/core/native-messages.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import { serializeCitation } from "../src/core/citations.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(id: string, content: AssistantMessage["content"]): LhMessage {
	return { id, role: "assistant", content, api: "faux", provider: "faux", model: "m", usage, stopReason: "toolUse", timestamp: 1 } as LhMessage;
}
const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 });

const quizArgs = {
	question: "Which rule differentiates sin(x^2)?",
	options: [{ label: "Chain rule", value: "chain" }, { label: "Product rule", value: "product" }],
	explanation: "SECRET-EXPLANATION the outer function wraps the inner one",
	correctAnswer: "chain",
};

const quizCall = (id: string) => ({ type: "toolCall" as const, id, name: "quiz", arguments: quizArgs });

describe("parseSideQuestionInput", () => {
	const ok = { threadId: "side_1", thread: [], question: "Why?" };
	it("accepts a minimal body and keeps the optional passage", () => {
		assert.deepEqual(parseSideQuestionInput(ok), ok);
		assert.deepEqual(parseSideQuestionInput({ ...ok, passage: "p", sourceMessageId: "m1" }), { ...ok, passage: "p", sourceMessageId: "m1" });
		assert.deepEqual(parseSideQuestionInput({ ...ok, note: "last note" }), { ...ok, note: "last note" });
		const selector = { start: 4, end: 28, prefix: "and ", suffix: " here" };
		assert.deepEqual(parseSideQuestionInput({ ...ok, passage: "p", sourceMessageId: "m1", selector }), { ...ok, passage: "p", sourceMessageId: "m1", selector });
		assert.deepEqual(parseSideQuestionInput({ ...ok, thread: [{ question: "q", answer: "a", passage: "p", sourceMessageId: "m1", selector }] }).thread[0]!.selector, selector);
	});
	it("rejects bad shapes and the caps with ChatInputError", () => {
		const bad: unknown[] = [
			null, "x", {}, { ...ok, threadId: "" }, { ...ok, threadId: "x".repeat(129) }, { ...ok, question: "  " },
			{ ...ok, question: "q".repeat(SIDE_QUESTION_MAX_CHARS + 1) },
			{ ...ok, passage: "p".repeat(SIDE_PASSAGE_MAX_CHARS + 1) },
			{ ...ok, thread: "no" }, { ...ok, thread: [{ question: "q" }] }, { ...ok, note: 3 }, { ...ok, note: "n".repeat(2_601) },
			{ ...ok, passage: "p", selector: { start: 5, end: 2, prefix: "", suffix: "" } },
			{ ...ok, passage: "p", selector: { start: 0, end: 2, prefix: "x".repeat(33), suffix: "" } },
			{ ...ok, passage: "p", selector: { start: 0.5, end: 2, prefix: "", suffix: "" } },
			{ ...ok, selector: { start: 0, end: 2, prefix: "", suffix: "" } },
			{ ...ok, thread: Array.from({ length: SIDE_THREAD_MAX_PAIRS }, () => ({ question: "q", answer: "a" })) },
		];
		for (const body of bad) assert.throws(() => parseSideQuestionInput(body), ChatInputError, JSON.stringify(body)?.slice(0, 80));
	});
});

describe("parseSideCloseInput", () => {
	const pair = { question: "q", answer: "a", tell: true, note: "n" };
	it("accepts a thread with notes, the learner's toggle and an unanswered question", () => {
		const body = { threadId: "side_1", thread: [pair], learnerTell: null, pending: { question: "q2" } };
		assert.deepEqual(parseSideCloseInput(body), body);
		assert.deepEqual(parseSideCloseInput({ threadId: "side_1", thread: [], learnerTell: false }), { threadId: "side_1", thread: [], learnerTell: false });
	});
	it("rejects bad shapes", () => {
		for (const body of [
			{ threadId: "side_1", thread: [pair] },
			{ threadId: "side_1", thread: [{ ...pair, tell: "yes" }], learnerTell: null },
			{ threadId: "side_1", thread: [{ question: "q", answer: "a" }], learnerTell: null },
			{ threadId: "side_1", thread: Array.from({ length: SIDE_THREAD_MAX_PAIRS + 1 }, () => pair), learnerTell: null },
			{ threadId: "", thread: [], learnerTell: null },
		]) assert.throws(() => parseSideCloseInput(body), ChatInputError);
	});
});

describe("finalTell (F10)", () => {
	const recs = (...tells: boolean[]) => tells.map((tell) => ({ tell, note: "n" }));
	it("follows the newest recommendation when the learner never flipped", () => {
		assert.equal(finalTell(recs(false, true), null), true);
		assert.equal(finalTell(recs(true, false), null), false);
		assert.equal(finalTell([], null), false);
	});
	it("keeps the learner's last setting over any recommendation", () => {
		assert.equal(finalTell(recs(false, false), true), true);
		assert.equal(finalTell(recs(true, true), false), false);
	});
});

describe("sideTranscript", () => {
	it("hides a pending question's answer key and its synthesized interrupted result", () => {
		const record = [user("u1", "Teach me derivatives"), assistant("a1", [{ type: "text", text: "Let's check." }, quizCall("call_q")])];
		const out = sideTranscript(record);
		assert.match(out, /\[LEARNER\] Teach me derivatives/);
		assert.match(out, /\[TUTOR\] Let's check\./);
		assert.match(out, /\[TUTOR\] \(question quiz, waiting for the learner's answer: /);
		assert.match(out, /Which rule differentiates sin\(x\^2\)\?/);
		assert.doesNotMatch(out, /SECRET-EXPLANATION/);
		assert.doesNotMatch(out, /correctAnswer/);
		assert.doesNotMatch(out, /interrupted/i);
		assert.doesNotMatch(out, /\[RESULT/);
	});

	it("keeps an answered question's arguments and its result", () => {
		const answer = { kind: "quiz", questionText: quizArgs.question, answers: ["chain"], dontKnow: false, answeredAt: "t" };
		const record = [user("u1", "go"), assistant("a1", [quizCall("call_q")]), newAnswerResult("call_q", "quiz", answer) as LhMessage];
		const out = sideTranscript(record);
		assert.match(out, /\(tool call quiz: .*SECRET-EXPLANATION/);
		assert.match(out, /\[RESULT for quiz\] /);
	});

	it("renders the output tool as tutor prose and skips thinking", () => {
		const record = [assistant("a1", [
			{ type: "thinking", thinking: "PRIVATE-THOUGHT" },
			{ type: "toolCall", id: "c1", name: "send_to_user", arguments: { message: "The chain rule multiplies." } },
		])];
		const out = sideTranscript(record);
		assert.match(out, /\[TUTOR\] The chain rule multiplies\./);
		assert.doesNotMatch(out, /PRIVATE-THOUGHT/);
		assert.doesNotMatch(out, /tool call send_to_user/);
	});

	it("truncates long tool results", () => {
		const record: LhMessage[] = [assistant("a1", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }]),
			{ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "z".repeat(5_000) }], isError: false, timestamp: 1 } as LhMessage];
		const line = sideTranscript(record).split("\n").find((l) => l.startsWith("[RESULT for read]"))!;
		assert.ok(line.length < 2_100, String(line.length));
	});

	it("shows the compaction summary instead of the cut span", () => {
		const record: LhMessage[] = [user("u1", "OLD-TURN"), assistant("a1", [{ type: "text", text: "old answer" }]), user("u2", "recent")];
		record.push(newCompactionMarker("The learner covered limits.", { firstKeptMessageId: "u2", tokensBefore: 10, at: "t" }));
		const out = sideTranscript(record);
		assert.doesNotMatch(out, /OLD-TURN/);
		assert.match(out, /\[SUMMARY\] .*The learner covered limits\./s);
		assert.match(out, /\[LEARNER\] recent/);
	});

	it("labels marker text as [NOTE], never as the learner, and drops UI-only blocks", () => {
		const record: LhMessage[] = [
			newHandoffMessage("chat_1") as LhMessage,
			newPlanBlockMessage("p1", { title: "PLAN-BLOCK" }) as LhMessage,
			newSideQuestionMarker("side_told", { thread: [{ question: "q", answer: "a" }], note: "Already clarified: chain rule.", toldTutor: true }) as LhMessage,
			newSideQuestionMarker("side_quiet", { thread: [{ question: "q", answer: "a" }], note: "QUIET-NOTE", toldTutor: false }) as LhMessage,
		];
		const out = sideTranscript(record);
		assert.match(out, /\[NOTE\] Already clarified: chain rule\./);
		assert.match(out, /\[NOTE\] /);
		assert.doesNotMatch(out, /\[LEARNER\]/);
		assert.doesNotMatch(out, /PLAN-BLOCK|QUIET-NOTE/);
	});

	it("expands learner citations like the tutor's wire does", () => {
		const link = serializeCitation({ version: 1, chatId: "c", messageId: "m", text: "the derivatives multiply", start: 0, end: 24, prefix: "", suffix: "" });
		const out = sideTranscript([user("u1", `What about ${link}?`)]);
		assert.match(out, /\[tutor-quote-1\]/);
		assert.match(out, /the derivatives multiply/);
		assert.doesNotMatch(out, /lh-citation:/);
	});
});

describe("sideUserMessage", () => {
	it("lays out the transcript, the thread so far, and the new question", () => {
		const msg = sideUserMessage("[LEARNER] hi", {
			thread: [{ question: "What is f'?", answer: "The derivative.", passage: "f' = 2x" }, { question: "And f''?", answer: "2." }],
			question: "Why multiply?",
			passage: "the derivatives multiply",
			note: "Already clarified: f' and f''.",
		});
		assert.equal(msg, [
			"<tutor_transcript>", "[LEARNER] hi", "</tutor_transcript>", "",
			"<side_thread>",
			'Passage: "f\' = 2x"', "Learner: What is f'?", "You: The derivative.", "",
			"Learner: And f''?", "You: 2.", "",
			"Your last note: Already clarified: f' and f''.",
			"</side_thread>", "",
			'Passage: "the derivatives multiply"', "Learner: Why multiply?",
		].join("\n"));
	});
	it("omits the side thread block and the passage when there are none", () => {
		assert.equal(sideUserMessage("t", { thread: [], question: "q" }), "<tutor_transcript>\nt\n</tutor_transcript>\n\nLearner: q");
	});
});

describe("newSideQuestionMarker", () => {
	const details = { thread: [{ question: "q", answer: "a" }], note: "the note", toldTutor: true };
	it("carries the note as model-facing content only when told", () => {
		const told = newSideQuestionMarker("side_1", details);
		assert.equal(told.id, "side_1");
		assert.equal(told.role, "custom");
		assert.equal(told.customType, "side-question");
		assert.equal(told.content, "the note");
		assert.deepEqual(told.details, details);
		assert.equal(newSideQuestionMarker("side_2", { ...details, toldTutor: false }).content, "");
	});
});

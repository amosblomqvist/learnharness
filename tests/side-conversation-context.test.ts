import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { sideConversationEntries, sideSegmentId, sideEntryPoints, sideChatLessonDocument } from "../src/core/side-chat.ts";
import { asAgentMessages, endsInDismissal, nativeInputCause, needsContinuation, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { serializeForSummary } from "../src/core/compaction.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import type { SideChatThread } from "../src/core/contracts/chat.ts";

const teacher = (id: string, text: string): LhMessage => ({ ...fauxAssistantMessage(text), id });
const learner = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 });
const live: SideChatThread = {
	id: "side_segment", anchor: { messageId: "lesson", partId: "lesson-t0", blockIndex: 0, blockText: "Continuity." },
	open: true, createdAt: "2026-11-05T00:00:00Z", messages: [
		{ id: "question", role: "user", text: "Why can we take the limit?", quotes: ["The function is continuous."], at: "2026-11-05T00:00:01Z" },
		{ id: "reply", role: "assistant", text: "Continuity lets us pass the limit through the function.", at: "2026-11-05T00:00:02Z" },
	],
};
const frozen = { ...live, contextSnapshot: live.messages };

describe("frozen raw learner–helper context", () => {
	it("does not deliver an open conversation before main submission freezes it", () => {
		assert.deepEqual(sideConversationEntries({ messages: [], sideChats: [live] }), []);
		assert.deepEqual(sideConversationEntries({ messages: [], sideChats: [{ ...live, contextSnapshot: [] }] }), []);
	});
	it("persists one attributed custom snapshot and projects a user-role reference, never a tutor reply", () => {
		const messages = [learner("start", "Explain continuity"), teacher("lesson", "The function is continuous.")];
		const entries = sideConversationEntries({ messages, sideChats: [frozen] });
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.role, "custom");
		assert.match(entries[0]!.content, /Recorded learner–helper conversation/);
		assert.match(entries[0]!.content, /Learner:\nWhy can we take the limit\?/);
		assert.match(entries[0]!.content, /Quoted tutor passage:\nThe function is continuous\./);
		assert.match(entries[0]!.content, /Helper:\nContinuity lets us pass the limit through the function\./);
		const wire = toLlmMessages(asAgentMessages([...messages, ...entries]));
		assert.equal(wire.at(-1)!.role, "user");
		assert.doesNotMatch(JSON.stringify(wire), /customType|segmentMessageId|generatedSummary|toldTutor/);
		assert.equal(nativeInputCause(entries[0]!, messages), "neutral");
	});
	it("later replies and follow-ups cannot revise or add teacher context, even before initial delivery", () => {
		const entries = sideConversationEntries({ messages: [], sideChats: [frozen] });
		const continued = { ...frozen, messages: [...live.messages, {
			id: "followup", role: "user" as const, text: "UI-ONLY-LATE-QUESTION", at: "2026-11-05T00:00:03Z",
		}] };
		assert.deepEqual(sideConversationEntries({ messages: [], sideChats: [continued] }), entries);
		assert.deepEqual(sideConversationEntries({ messages: entries, sideChats: [continued] }), []);
		assert.doesNotMatch(JSON.stringify(entries), /UI-ONLY/);
	});
	it("preserves exactly the partial text at cutoff, marking it as still generating", () => {
		const snapshot = [{ ...live.messages[1]!, pending: true, text: "Continuity lets…" }];
		const entries = sideConversationEntries({ messages: [], sideChats: [{ ...live, contextSnapshot: snapshot }] });
		assert.match(entries[0]!.content, /Helper:\nContinuity lets…\n\[This helper reply was still generating/);
		assert.doesNotMatch(entries[0]!.content, /pass the limit through/);
	});
	it("marks stopped and failed replies honestly", () => {
		for (const flags of [{ stopped: true }, { error: "failure" }]) {
			const snapshot = [{ ...live.messages[1]!, ...flags, text: "Partial" }];
			assert.match(sideConversationEntries({ messages: [], sideChats: [{ ...live, contextSnapshot: snapshot }] })[0]!.content, /incomplete/);
		}
	});
	it("keeps snapshots invisible to transcript chrome/extraction, but available to main compaction", () => {
		const first = teacher("lesson", "An explanation.");
		const entries = sideConversationEntries({ messages: [first], sideChats: [frozen] });
		const view = projectView([first, ...entries, teacher("next_step", "Here is the associated check.")]);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.parts.filter((part) => part.type === "text").length, 2);
		assert.doesNotMatch(sessionMarkdown([first, ...entries]), /Why can we take the limit/);
		assert.match(serializeForSummary(entries), /LEARNER–HELPER CONVERSATION/);
	});
	it("does not feed the helper its own exchange twice through the lesson", () => {
		const messages = [teacher("lesson", "The function is continuous.")];
		const entries = sideConversationEntries({ messages, sideChats: [frozen] });
		const document = sideChatLessonDocument([...messages, ...entries]);
		assert.match(document, /The function is continuous/);
		assert.doesNotMatch(document, /Why can we take the limit|Helper:|Recorded learner/);
	});
	it("is neutral to dismissal and native continuation decisions", () => {
		const entries = sideConversationEntries({ messages: [], sideChats: [frozen] });
		const dismissal: LhMessage = { id: "dismissal", role: "toolResult", toolCallId: "question", toolName: "quiz", content: [{ type: "text", text: "Skipped" }], details: { dismissed: true }, isError: false, timestamp: 1 };
		assert.equal(endsInDismissal([dismissal, ...entries]), true);
		assert.equal(needsContinuation([dismissal, ...entries]), false);
	});
});

describe("one explanation/check segment", () => {
	it("keeps separate persistent entries when answer results leave multiple teaching steps in one display group", () => {
		const work: LhMessage = { ...fauxAssistantMessage([fauxToolCall("read", { path: "synthetic.md" }, { id: "read" })], { stopReason: "toolUse" }), id: "work" };
		const question: LhMessage = { ...fauxAssistantMessage([fauxToolCall("quiz", { question: "First check" }, { id: "check" })], { stopReason: "toolUse" }), id: "question" };
		const answer: LhMessage = { id: "answer", role: "toolResult", toolName: "quiz", toolCallId: "check", content: [{ type: "text", text: "Answered" }], isError: false, timestamp: 1 };
		const messages = [learner("start", "Teach me"), work, teacher("lesson", "First explanation"), question, answer,
			...sideConversationEntries({ messages: [], sideChats: [frozen] }), teacher("next", "Next explanation"), teacher("associated", "Its associated question")];
		const view = projectView(messages);
		const group = view.find((message) => message.role === "assistant")!;
		assert.equal(view.filter((message) => message.role === "assistant").length, 1, "the continuous-document layout is unchanged");
		const points = sideEntryPoints(messages, view).get(group.id)!;
		assert.deepEqual([...points.values()], ["work", "next"]);
		const indices = [...points.keys()];
		assert.equal(group.parts[indices[0]!]!.sourceMessageId, "next", "old entry precedes the next teaching step");
		assert.equal(indices[1], group.parts.length);
		assert.equal(sideSegmentId(messages, "lesson"), "work");
		assert.equal(sideSegmentId(messages, "question"), "work");
		assert.equal(sideSegmentId(messages, "associated"), "next");
		assert.deepEqual([...sideEntryPoints([work], projectView([work])).get("work")!.values()], [], "invisible work alone has no entry");
	});
	it("groups assistant steps and source references, but ends on real learner input", () => {
		const messages = [learner("start", "Teach me"), teacher("lesson", "Explanation"), teacher("check", "Question")];
		assert.equal(sideSegmentId(messages, "check"), "lesson");
		const entries = sideConversationEntries({ messages, sideChats: [frozen] });
		assert.equal(sideSegmentId([...messages, ...entries]), "lesson");
		assert.equal(sideSegmentId([...messages, ...entries, learner("answer", "My answer")]), null);
		assert.equal(sideSegmentId([...messages, ...entries, learner("answer", "My answer"), teacher("reaction", "Next explanation")]), "reaction");
		assert.equal(sideSegmentId(messages, "missing"), null);
	});
});

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
const partial = { ...live, messages: [live.messages[0]!, { ...live.messages[1]!, text: "Continuity lets", pending: true }] };
const entries = (messages: LhMessage[], threads: SideChatThread[]) => sideConversationEntries({ messages, sideChats: threads });
const wire = (messages: LhMessage[]) => JSON.stringify(toLlmMessages(asAgentMessages(messages)));

describe("append-only raw learner–helper updates", () => {
	it("records each new raw exchange once, attributed to learner/helper and projected as user-role reference", () => {
		const messages = [learner("start", "Explain continuity"), teacher("lesson", "The function is continuous.")];
		const updates = entries(messages, [live]);
		assert.equal(updates.length, 2);
		assert.match(updates[0]!.content, /Learner:\nWhy can we take the limit\?/);
		assert.match(updates[0]!.content, /Quoted tutor passage:\nThe function is continuous\./);
		assert.match(updates[1]!.content, /Helper:\nContinuity lets us pass the limit through the function\./);
		const projected = toLlmMessages(asAgentMessages([...messages, ...updates]));
		assert.equal(projected.at(-1)!.role, "user");
		assert.doesNotMatch(JSON.stringify(projected), /customType|threadId|updates|generatedSummary|toldTutor/);
		assert.equal(nativeInputCause(updates[0]!, messages), "neutral");
		assert.deepEqual(entries([...messages, ...updates], [live]), []);
	});
	it("appends a partial reply's remaining text and later follow-ups without rewriting or repeating its prefix", () => {
		const first = entries([], [partial]); const unchanged = structuredClone(first);
		const continued = { ...live, messages: [...live.messages, { id: "followup", role: "user" as const, text: "A later question in the old thread", at: "2026-11-05T00:00:03Z" }] };
		const next = entries(first, [continued]);
		assert.equal(next.length, 2);
		assert.match(next[0]!.content, /Helper \(continued reply\):\n us pass the limit/);
		assert.match(next[0]!.content, /now complete/);
		assert.doesNotMatch(JSON.stringify(next), /Continuity lets/, "the ledger also stores only new suffixes, not growing full-prefix copies");
		assert.match(next[1]!.content, /later question in the old thread/);
		assert.deepEqual(first, unchanged);
		assert.equal(wire([...first, ...next]).split("Continuity lets").length - 1, 1);
		assert.deepEqual(entries([...first, ...next], [continued]), []);
	});
	it("reconstructs several partial deliveries without repeating their cumulative prefix", () => {
		const early = { ...partial, messages: [partial.messages[0]!, { ...partial.messages[1]!, text: "Continuity" }] };
		const first = entries([], [early]); const middle = entries(first, [partial]);
		assert.equal(middle.length, 1); assert.match(middle[0]!.content, /continued reply/);
		assert.doesNotMatch(JSON.stringify(middle), /Continuity/);
		const last = entries([...first, ...middle], [live]);
		assert.equal(last.length, 1); assert.doesNotMatch(JSON.stringify(last), /Continuity lets/);
		assert.deepEqual(entries([...first, ...middle, ...last], [live]), []);
	});
	it("collects all conversations, in observed message-time order rather than thread creation order", () => {
		const later = { ...live, messages: [...live.messages, { id: "late", role: "user" as const, text: "OLD THREAD, NEW QUESTION", at: "2026-11-05T00:00:05Z" }] };
		const other = { ...live, id: "side_other", messages: [{ id: "other", role: "user" as const, text: "NEW THREAD QUESTION", at: "2026-11-05T00:00:04Z" }] };
		const initial = entries([], [live]); const next = entries(initial, [later, other]);
		assert.equal(next.length, 2);
		assert.match(next[0]!.content, /NEW THREAD QUESTION/);
		assert.match(next[1]!.content, /OLD THREAD, NEW QUESTION/);
		assert.deepEqual(entries([...initial, ...next], [later, other]), []);
	});
	it("reports terminal status once even when completion adds no new text", () => {
		const first = entries([], [partial]);
		const complete = { ...partial, messages: [partial.messages[0]!, { ...partial.messages[1]!, pending: false }] };
		const next = entries(first, [complete]);
		assert.equal(next.length, 1);
		assert.match(next[0]!.content, /reply status update/);
		assert.match(next[0]!.content, /now complete/);
		assert.doesNotMatch(next[0]!.content, /Continuity lets/);
		assert.deepEqual(entries([...first, ...next], [complete]), []);
	});
	it("honestly appends stopped/failed status and non-prefix corrections instead of editing earlier text", () => {
		const first = entries([], [partial]); const unchanged = structuredClone(first);
		for (const flags of [{ stopped: true }, { error: "failure" }]) {
			const stopped = { ...partial, messages: [partial.messages[0]!, { ...partial.messages[1]!, pending: false, ...flags }] };
			assert.match(entries(first, [stopped])[0]!.content, /incomplete/);
		}
		const corrected = { ...live, messages: [live.messages[0]!, { ...live.messages[1]!, text: "A corrected reply." }] };
		assert.match(entries(first, [corrected])[0]!.content, /updated wording of the earlier reply/);
		assert.deepEqual(first, unchanged);
	});
	it("continues legacy published snapshots but ignores obsolete per-thread cutoffs", () => {
		const old: LhMessage = { id: "exchange_side_segment", role: "custom", customType: "side-question", content: "LEGACY RAW PREFIX", display: false, timestamp: 1,
			details: { threadId: live.id, snapshot: partial.messages } };
		const legacyThread = { ...live, contextSnapshot: [] };
		const next = entries([old], [legacyThread]);
		assert.equal(next.length, 1); assert.match(next[0]!.content, /continued reply/);
		assert.equal(old.content, "LEGACY RAW PREFIX");
		assert.deepEqual(entries([old, ...next], [legacyThread]), []);
		assert.equal(entries([], [legacyThread]).length, 2, "an unpublished legacy cutoff does not consume exchanges");
	});
	it("marks a published partial interrupted exactly once if its ephemeral run was lost on restart", () => {
		const first = entries([], [partial]);
		const afterRestart = { ...live, messages: [live.messages[0]!] };
		const next = entries(first, [afterRestart]);
		assert.equal(next.length, 1); assert.match(next[0]!.content, /failed or was interrupted/);
		assert.doesNotMatch(next[0]!.content, /Continuity lets/);
		assert.deepEqual(entries([...first, ...next], [afterRestart]), []);
	});
	it("retains delivery bookkeeping across compaction without replaying old exchanges", () => {
		const first = entries([], [partial]);
		const compaction: LhMessage = { id: "cut", role: "custom", customType: "compaction", content: "Earlier history summary", details: {}, display: false, timestamp: 3 };
		const next = entries([...first, compaction], [live]);
		assert.equal(next.length, 1); assert.doesNotMatch(next[0]!.content, /Why can we take the limit|Continuity lets/);
	});
	it("keeps updates invisible to transcript chrome/extraction, but available to main compaction", () => {
		const first = teacher("lesson", "An explanation."); const updates = entries([first], [live]);
		const view = projectView([first, ...updates, teacher("next_step", "Here is the associated check.")]);
		assert.equal(view.length, 1); assert.equal(view[0]!.parts.filter((part) => part.type === "text").length, 2);
		assert.doesNotMatch(sessionMarkdown([first, ...updates]), /Why can we take the limit/);
		assert.match(serializeForSummary(updates), /LEARNER–HELPER CONVERSATION/);
	});
	it("does not feed the helper its own exchanges twice through the latest lesson", () => {
		const messages = [teacher("lesson", "The function is continuous.")];
		const document = sideChatLessonDocument([...messages, ...entries(messages, [live])]);
		assert.match(document, /The function is continuous/);
		assert.doesNotMatch(document, /Why can we take the limit|Helper:|Recorded learner/);
	});
	it("is neutral to dismissal and native continuation decisions", () => {
		const updates = entries([], [live]);
		const dismissal: LhMessage = { id: "dismissal", role: "toolResult", toolCallId: "question", toolName: "quiz", content: [{ type: "text", text: "Skipped" }], details: { dismissed: true }, isError: false, timestamp: 1 };
		assert.equal(endsInDismissal([dismissal, ...updates]), true);
		assert.equal(needsContinuation([dismissal, ...updates]), false);
	});
});

describe("one explanation/check segment", () => {
	it("keeps separate persistent entries when answer results leave multiple teaching steps in one display group", () => {
		const work: LhMessage = { ...fauxAssistantMessage([fauxToolCall("read", { path: "synthetic.md" }, { id: "read" })], { stopReason: "toolUse" }), id: "work" };
		const question: LhMessage = { ...fauxAssistantMessage([fauxToolCall("quiz", { question: "First check" }, { id: "check" })], { stopReason: "toolUse" }), id: "question" };
		const answer: LhMessage = { id: "answer", role: "toolResult", toolName: "quiz", toolCallId: "check", content: [{ type: "text", text: "Answered" }], isError: false, timestamp: 1 };
		const messages = [learner("start", "Teach me"), work, teacher("lesson", "First explanation"), question, answer,
			...entries([], [live]), teacher("next", "Next explanation"), teacher("associated", "Its associated question")];
		const view = projectView(messages); const group = view.find((message) => message.role === "assistant")!;
		assert.equal(view.filter((message) => message.role === "assistant").length, 1);
		const points = sideEntryPoints(messages, view).get(group.id)!;
		assert.deepEqual([...points.values()], ["work", "next"]);
		const indices = [...points.keys()]; assert.equal(group.parts[indices[0]!]!.sourceMessageId, "next"); assert.equal(indices[1], group.parts.length);
		assert.equal(sideSegmentId(messages, "lesson"), "work"); assert.equal(sideSegmentId(messages, "question"), "work"); assert.equal(sideSegmentId(messages, "associated"), "next");
		assert.deepEqual([...sideEntryPoints([work], projectView([work])).get("work")!.values()], []);
	});
	it("groups assistant steps and source references, but ends on real learner input", () => {
		const messages = [learner("start", "Teach me"), teacher("lesson", "Explanation"), teacher("check", "Question")];
		assert.equal(sideSegmentId(messages, "check"), "lesson");
		const updates = entries(messages, [live]);
		assert.equal(sideSegmentId([...messages, ...updates]), "lesson");
		assert.equal(sideSegmentId([...messages, ...updates, learner("answer", "My answer")]), null);
		assert.equal(sideSegmentId([...messages, ...updates, learner("answer", "My answer"), teacher("reaction", "Next explanation")]), "reaction");
		assert.equal(sideSegmentId(messages, "missing"), null);
	});
});

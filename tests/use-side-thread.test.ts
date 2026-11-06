import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sideThreadReducer as reduce, type SideThreadState } from "../components/use-side-thread.ts";
import type { SideChatThread } from "../src/core/contracts/chat.ts";

const anchor = { kind: "composer" as const };
const thread: SideChatThread = { id: "side_lesson", anchor: { messageId: "lesson", partId: "lesson-t0", blockIndex: 0, blockText: "Explanation" },
	open: true, createdAt: "2026-11-05T00:00:00Z", messages: [{ id: "ask", role: "user", text: "Why?", at: "2026-11-05T00:00:01Z" }] };
const open = (): SideThreadState => reduce(null, { type: "open", segmentId: "lesson", anchor, thread })!;

describe("one durable side companion", () => {
	it("opens the existing segment conversation, never a new selection-specific thread", () => {
		const first = open();
		assert.equal(first.threadId, "side_lesson");
		assert.equal(first.messages.length, 1);
		const docked = reduce(first, { type: "mode", mode: "panel" });
		const quoted = reduce(docked, { type: "open", segmentId: "lesson", anchor, passage: { text: "Selected words", sourceMessageId: "lesson" } })!;
		assert.equal(quoted.threadId, first.threadId);
		assert.equal(quoted.mode, "panel");
		assert.equal(quoted.messages, first.messages);
		assert.equal(quoted.pendingPassage?.text, "Selected words");
	});
	it("keeps a newly selected passage through reconnects until that question is accepted", () => {
		const passage = { text: "For the next question", sourceMessageId: "lesson" };
		let state = reduce(open(), { type: "open", segmentId: "lesson", anchor, passage });
		state = reduce(state, { type: "snapshot", thread, answering: true, text: "An earlier answer" });
		state = reduce(state, { type: "text", threadId: thread.id, text: "An earlier answer continues" });
		assert.deepEqual(state?.pendingPassage, passage);
		state = reduce(state, { type: "accepted", threadId: thread.id });
		assert.equal(state?.pendingPassage, undefined);
	});
	it("marks a first-time old-step conversation UI-only before an ask exists", () => {
		assert.equal(reduce(null, { type: "open", segmentId: "old", anchor, contextFrozen: true })?.contextFrozen, true);
	});
	it("uses replacement text snapshots, not appended duplicate deltas", () => {
		let state = reduce(open(), { type: "start", threadId: thread.id });
		state = reduce(state, { type: "text", threadId: thread.id, text: "One" });
		state = reduce(state, { type: "text", threadId: thread.id, text: "One sentence." });
		assert.equal(state?.streamText, "One sentence.");
		assert.equal(state?.answering, true);
	});
	it("never lets a detached stream overwrite the newly opened thread", () => {
		const next = reduce(open(), { type: "open", segmentId: "next", anchor });
		assert.equal(reduce(next, { type: "text", threadId: thread.id, text: "STALE" }), next);
		assert.equal(reduce(next, { type: "done", thread }), next);
		assert.equal(reduce(next, { type: "error", threadId: thread.id, error: "STALE" }), next);
	});
	it("closing only drops the view; reopening still has its durable history", () => {
		assert.equal(reduce(open(), { type: "close" }), null);
		assert.deepEqual(open().messages, thread.messages);
	});
	it("can float again after docking, without discarding the conversation", () => {
		const state = reduce(reduce(open(), { type: "mode", mode: "panel" }), { type: "mode", mode: "popover" });
		assert.deepEqual(state?.messages, thread.messages);
		assert.equal(state?.mode, "popover");
	});
	it("shows the immutable cutoff while later messages remain fully usable", () => {
		const frozen = { ...thread, contextSnapshot: thread.messages, messages: [...thread.messages, {
			id: "reply", role: "assistant" as const, text: "A late answer.", at: "2026-11-05T00:00:02Z",
		}] };
		const state = reduce(open(), { type: "done", thread: frozen })!;
		assert.equal(state.contextFrozen, true);
		assert.equal(state.messages.length, 2);
		assert.equal(state.answering, false);
		assert.equal(reduce(state, { type: "snapshot", thread })?.contextFrozen, true, "an older reconnect frame cannot reopen teacher context");
	});
	it("keeps a refused initial /btw question available rather than silently losing it", () => {
		const failed = reduce(open(), { type: "error", threadId: thread.id, error: "No model", question: "Why?" });
		assert.equal(failed?.failedQuestion, "Why?");
		assert.equal(failed?.answering, false);
		assert.equal(reduce(failed, { type: "start", threadId: thread.id })?.error, undefined);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayedTell, sideCloseBody, sideThreadReducer, type SideThreadAction, type SideThreadState } from "../components/use-side-thread.ts";

const run = (...actions: SideThreadAction[]): SideThreadState | null =>
	actions.reduce<SideThreadState | null>((s, a) => sideThreadReducer(s, a), null);
const open: SideThreadAction = { type: "open", threadId: "side_1", anchor: { kind: "composer" } };
const passage = { text: "the derivatives multiply", sourceMessageId: "msg_1" };

describe("sideThreadReducer", () => {
	it("accumulates streamed text and completes the pair on the note frame", () => {
		const s = run(open, { type: "ask", question: " Why? " }, { type: "tool", name: "read", label: "notes.md" }, { type: "text", delta: "Be" }, { type: "text", delta: "cause." })!;
		assert.deepEqual(s.draft, { question: "Why?", answer: "Because." });
		const done = sideThreadReducer(s, { type: "note", tell: true, note: "n" })!;
		assert.equal(done.draft, null);
		assert.deepEqual(done.pairs, [{ question: "Why?", answer: "Because.", tell: true, note: "n" }]);
	});

	it("shows the tool activity until text arrives", () => {
		const s = run(open, { type: "ask", question: "q" }, { type: "tool", name: "grep", label: "chain" })!;
		assert.equal(s.draft?.activity, "grep chain");
		assert.equal(sideThreadReducer(s, { type: "text", delta: "x" })!.draft?.activity, undefined);
	});

	it("moves the toggle to each new recommendation until the learner flips it", () => {
		const one = run(open, { type: "ask", question: "a" }, { type: "note", tell: false, note: "n1" })!;
		assert.equal(displayedTell(one), false);
		const two = run(open, { type: "ask", question: "a" }, { type: "note", tell: false, note: "n1" }, { type: "ask", question: "b" }, { type: "note", tell: true, note: "n2" })!;
		assert.equal(displayedTell(two), true);
		const flipped = sideThreadReducer(sideThreadReducer(two, { type: "set-tell", tell: false }), { type: "ask", question: "c" })!;
		const three = sideThreadReducer(flipped, { type: "note", tell: true, note: "n3" })!;
		assert.equal(displayedTell(three), false, "the learner's setting wins");
		assert.equal(three.learnerTell, false);
	});

	it("keeps a failed question for retry and restores its passage", () => {
		const s = run({ ...open, passage }, { type: "ask", question: "Why?" }, { type: "error", error: "boom" })!;
		assert.equal(s.draft, null);
		assert.deepEqual(s.failed, { question: "Why?", error: "boom" });
		assert.deepEqual(s.pendingPassage, passage);
		const retried = sideThreadReducer(s, { type: "ask", question: "Why?" })!;
		assert.equal(retried.failed, undefined);
		assert.equal(retried.draft?.passage, passage.text);
	});

	it("carries a passage's selector into the question and the close body", () => {
		const selector = { start: 0, end: 5, prefix: "", suffix: " x" };
		const s = run(open, { type: "add-passage", passage: { ...passage, selector } }, { type: "ask", question: "q" })!;
		assert.deepEqual(s.draft?.selector, selector);
		assert.deepEqual(sideCloseBody(s).pending, { question: "q", passage: passage.text, sourceMessageId: "msg_1", selector });
	});

	it("attaches an added passage to the next question only", () => {
		const s = run(open, { type: "ask", question: "a" }, { type: "note", tell: false, note: "n" }, { type: "add-passage", passage }, { type: "ask", question: "b" })!;
		assert.deepEqual(s.draft, { question: "b", answer: "", passage: passage.text, sourceMessageId: "msg_1" });
		assert.equal(s.pendingPassage, undefined);
	});

	it("asks one question at a time and ignores blank ones", () => {
		const s = run(open, { type: "ask", question: "a" })!;
		assert.equal(sideThreadReducer(s, { type: "ask", question: "b" }), s);
		const idle = run(open)!;
		assert.equal(sideThreadReducer(idle, { type: "ask", question: "   " }), idle);
	});

	it("a read-only thread ignores asks and the toggle", () => {
		const details = { thread: [{ question: "q", answer: "a" }], note: "n", toldTutor: true };
		const s = run({ type: "open-read-only", threadId: "side_9", details, anchor: { kind: "composer" } })!;
		assert.equal(sideThreadReducer(s, { type: "ask", question: "more" }), s);
		assert.equal(sideThreadReducer(s, { type: "set-tell", tell: false }), s);
		assert.equal(displayedTell(s), true);
	});

	it("marks a reopened private thread as told", () => {
		const details = { thread: [{ question: "q", answer: "a" }], note: "n", toldTutor: false };
		const s = run({ type: "open-read-only", threadId: "side_9", details, anchor: { kind: "composer" } })!;
		assert.equal(displayedTell(s), false);
		assert.equal(displayedTell(sideThreadReducer(s, { type: "told", threadId: "side_9" })!), true);
		assert.equal(sideThreadReducer(s, { type: "told", threadId: "other" }), s);
	});

	it("continues a reopened thread under a new id, carrying the old pairs and note", () => {
		const details = { thread: [{ question: "q", answer: "a" }], note: "old note", toldTutor: true };
		const reopened = run({ type: "open-read-only", threadId: "side_9", details, anchor: { kind: "composer" } })!;
		const s = sideThreadReducer(sideThreadReducer(reopened, { type: "continue", threadId: "side_10" }), { type: "ask", question: "more?" })!;
		assert.equal(s.threadId, "side_10");
		assert.equal(s.continues, "side_9");
		assert.equal(s.readOnly, undefined);
		assert.equal(s.learnerTell, null);
		assert.deepEqual(s.pairs, [{ question: "q", answer: "a", tell: true, note: "old note" }]);
		assert.equal(s.draft?.question, "more?");
		assert.equal(sideCloseBody(s).continues, "side_9");
		assert.equal(sideThreadReducer(s, { type: "continue", threadId: "x" }), s, "a live thread doesn't continue");
	});

	it("expands into the panel and closes to nothing", () => {
		assert.equal(run(open, { type: "expand" })!.mode, "panel");
		assert.equal(run(open, { type: "close" }), null);
	});
});

describe("sideCloseBody", () => {
	it("sends the pairs, the learner's toggle and the question still streaming", () => {
		const s = run({ ...open, passage }, { type: "ask", question: "a" }, { type: "note", tell: true, note: "n" }, { type: "set-tell", tell: false }, { type: "add-passage", passage }, { type: "ask", question: "b" })!;
		assert.deepEqual(sideCloseBody(s), {
			threadId: "side_1",
			thread: [{ question: "a", answer: "", passage: passage.text, sourceMessageId: "msg_1", tell: true, note: "n" }],
			learnerTell: false,
			pending: { question: "b", passage: passage.text, sourceMessageId: "msg_1" },
		});
	});
});

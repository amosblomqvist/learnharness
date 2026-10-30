import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courseHealth, isIsoDate, lessonOverdue, lessonStatus, sessionDone } from "../src/core/course-progress.ts";
import { callMsg, lesson, resultMsg, teachSession, tree, userMsg } from "./helpers/course-fixtures.ts";

describe("course progress (derived)", () => {
	it("a session is done once every node was reached and the latest tagged call is answered", () => {
		assert.equal(sessionDone(teachSession({ probeMinutes: 2, nodes: [["a", 3], ["b", 3]] })), true);
	});

	it("the last check merely posed is NOT done", () => {
		assert.equal(sessionDone(teachSession({ probeMinutes: 2, nodes: [["a", 3], ["b", 3]], answerLast: false })), false);
	});

	it("a node never reached is not done", () => {
		assert.equal(sessionDone(teachSession({ probeMinutes: 2, nodes: [["a", 3]], treeIds: ["a", "b"] })), false);
	});

	it("an errored or dismissed final answer is not done", () => {
		const base = [userMsg(0), callMsg(1, "quiz", { nodeId: "a" }, "q1")];
		assert.equal(sessionDone({ tree: tree("a"), messages: [...base, resultMsg(2, "q1", "quiz", { isError: true })] }), false);
		assert.equal(sessionDone({ tree: tree("a"), messages: [...base, resultMsg(2, "q1", "quiz", { details: { dismissed: true } })] }), false);
		assert.equal(sessionDone({ tree: tree("a"), messages: [...base, resultMsg(2, "q1", "quiz", { details: {} })] }), true);
	});

	it("explain calls count; tags for nodes outside the current tree are ignored", () => {
		const messages = [userMsg(0), callMsg(1, "explain", { nodeId: "a" }, "e1"), resultMsg(2, "e1", "explain"), callMsg(3, "quiz", { nodeId: "dropped" }, "q2")];
		assert.equal(sessionDone({ tree: tree("a"), messages }), true, "the dangling call is on a node the rewrite dropped");
	});

	it("no tree, empty tree, or a practice session is never done", () => {
		const s = teachSession({ probeMinutes: 1, nodes: [["a", 1]] });
		assert.equal(sessionDone({ messages: s.messages }), false);
		assert.equal(sessionDone({ ...s, tree: tree() }), false);
		assert.equal(sessionDone({ ...s, kind: "practice" }), false);
	});

	it("lesson status: done if ANY linked session is done; deleted sessions are ignored", () => {
		const done = teachSession({ probeMinutes: 1, nodes: [["a", 1]] });
		const open = teachSession({ probeMinutes: 1, nodes: [["a", 1]], answerLast: false });
		const chats = new Map([["s1", open], ["s2", done]]);
		assert.equal(lessonStatus(lesson({ id: "l", sessionIds: ["s1", "s2"] }), chats), "done");
		assert.equal(lessonStatus(lesson({ id: "l", sessionIds: ["s1"] }), chats), "in-progress");
		assert.equal(lessonStatus(lesson({ id: "l", sessionIds: ["gone"] }), chats), "not-started");
		assert.equal(lessonStatus(lesson({ id: "l" }), chats), "not-started");
	});

	it("overdue and health", () => {
		const l = lesson({ id: "l", targetDate: "2026-10-29" });
		assert.equal(lessonOverdue(l, "in-progress", "2026-10-30"), true);
		assert.equal(lessonOverdue(l, "done", "2026-10-30"), false);
		assert.equal(lessonOverdue(l, "not-started", "2026-10-29"), false, "due today is not overdue");
		assert.equal(courseHealth([false, true]), "behind");
		assert.equal(courseHealth([false]), "on-track");
	});

	it("isIsoDate is strict", () => {
		assert.equal(isIsoDate("2026-02-28"), true);
		assert.equal(isIsoDate("2026-02-30"), false);
		assert.equal(isIsoDate("2026-2-3"), false);
		assert.equal(isIsoDate(20261030), false);
	});
});

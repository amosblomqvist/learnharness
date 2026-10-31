/**
 * Study-time service (docs/designs/study-time.md): src/server/study.ts
 * against a temp LH_DATA_DIR with real chat files and settings.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-service-"));
process.env.LH_DATA_DIR = dir;
const { stores } = await import("../src/server/stores.ts");
const { closeStudyOnShutdown, recordStudy, studyHistory } = await import("../src/server/study.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
	fs.rmSync(path.join(dir, "study"), { recursive: true, force: true });
	stores.settingsStore.writeSettings({ version: 1 });
});

const MIN = 60_000;
const T0 = new Date("2026-10-28T10:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

function startedChat(): string {
	const chat = stores.chatStore.createChat("Started");
	stores.chatStore.saveMessages(chat.id, [newUserMessage("hello")]);
	return chat.id;
}

/** Active at `from`, then a ping every 2 minutes up to (and including) `to`. */
function studyFor(chatId: string, windowId: string, from: number, to: number): void {
	for (let t = from; t <= to; t += 2 * MIN) recordStudy({ type: "active", chatId, windowId }, plus(t));
}

describe("recordStudy", () => {
	it("404 for an unknown chat, 400 for an unstarted one; nothing is opened", () => {
		assert.deepEqual(recordStudy({ type: "active", chatId: "nope", windowId: "w" }, T0), { ok: false, status: 404, error: "chat_not_found" });
		const empty = stores.chatStore.createChat("Empty");
		assert.deepEqual(recordStudy({ type: "active", chatId: empty.id, windowId: "w" }, T0), { ok: false, status: 400, error: "chat_not_started" });
		assert.deepEqual(stores.studyStore.readOpen().timers, {});
	});

	it("active, ping, stop: one interval with endReason stop", () => {
		const id = startedChat();
		assert.deepEqual(recordStudy({ type: "active", chatId: id, windowId: "w" }, T0), { ok: true });
		studyFor(id, "w", 2 * MIN, 40 * MIN);
		recordStudy({ type: "stop", chatId: id, windowId: "w" }, plus(40 * MIN));
		assert.deepEqual(stores.studyStore.readIntervals(), [
			{ v: 1, chatId: id, start: T0.toISOString(), end: plus(40 * MIN).toISOString(), endReason: "stop" },
		]);
		assert.deepEqual(stores.studyStore.readOpen().timers, {});
	});

	it("the same-window ping reads no chat file (works after the chat is deleted)", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w" }, T0);
		stores.chatStore.deleteChat(id);
		assert.deepEqual(recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(MIN)), { ok: true });
		assert.deepEqual(recordStudy({ type: "stop", chatId: id, windowId: "w" }, plus(2 * MIN)), { ok: true }, "stop does not check the chat");
		assert.equal(stores.studyStore.readIntervals().length, 1);
	});

	it("idle: the next request after lastPing + N closes the timer at lastPing", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w" }, T0);
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(MIN));
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(30 * MIN));
		const [first] = stores.studyStore.readIntervals();
		assert.deepEqual(first, { v: 1, chatId: id, start: T0.toISOString(), end: plus(MIN).toISOString(), endReason: "idle" });
		assert.equal(stores.studyStore.readOpen().timers[id]?.start, plus(30 * MIN).toISOString(), "a new timer, not the old one reopened");
	});

	it("restart recovery: a new page's active closes the old timer at its last ping", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "before" }, T0);
		recordStudy({ type: "active", chatId: id, windowId: "before" }, plus(MIN));
		recordStudy({ type: "active", chatId: id, windowId: "after" }, plus(2 * MIN));
		assert.deepEqual(stores.studyStore.readIntervals().map((i) => [i.end, i.endReason]), [[plus(MIN).toISOString(), "idle"]]);
		assert.equal(stores.studyStore.readOpen().timers[id]?.windowId, "after");
	});

	it("another window's active on a deleted chat is 404, yet the old timer is closed and persisted", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w1" }, T0);
		recordStudy({ type: "active", chatId: id, windowId: "w1" }, plus(MIN));
		stores.chatStore.deleteChat(id);
		assert.deepEqual(recordStudy({ type: "active", chatId: id, windowId: "w2" }, plus(2 * MIN)), { ok: false, status: 404, error: "chat_not_found" });
		assert.equal(stores.studyStore.readIntervals().length, 1);
		assert.deepEqual(stores.studyStore.readOpen().timers, {});
	});

	it("a stop from another window is ignored", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w1" }, T0);
		recordStudy({ type: "stop", chatId: id, windowId: "w2" }, plus(MIN));
		assert.equal(stores.studyStore.readIntervals().length, 0);
		assert.equal(stores.studyStore.readOpen().timers[id]?.windowId, "w1");
	});

	it("closeAll closes every timer with endReason stop; with none it is a no-op", () => {
		assert.deepEqual(recordStudy({ type: "closeAll" }, T0), { ok: true });
		const a = startedChat();
		const b = startedChat();
		recordStudy({ type: "active", chatId: a, windowId: "w" }, T0);
		recordStudy({ type: "active", chatId: b, windowId: "w" }, plus(MIN));
		recordStudy({ type: "closeAll" }, plus(4 * MIN));
		assert.deepEqual(stores.studyStore.readIntervals().map((i) => [i.chatId, i.endReason]), [[a, "stop"], [b, "stop"]]);
		assert.deepEqual(stores.studyStore.readOpen().timers, {});
	});

	it("N comes from settings when the request is handled; written intervals never change", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w" }, T0);
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(MIN));
		stores.settingsStore.writeSettings({ version: 1, studyTime: { idleMinutes: 15 } });
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(10 * MIN)); // 9 min after the last ping: not stale at N = 15
		assert.equal(stores.studyStore.readIntervals().length, 0);
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(40 * MIN)); // 30 min: stale
		assert.equal(stores.studyStore.readIntervals().length, 1);
	});
});

describe("closeStudyOnShutdown", () => {
	it("closes every open timer at shutdown time with endReason shutdown", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w" }, T0);
		closeStudyOnShutdown(plus(3 * MIN));
		assert.deepEqual(stores.studyStore.readIntervals(), [
			{ v: 1, chatId: id, start: T0.toISOString(), end: plus(3 * MIN).toISOString(), endReason: "shutdown" },
		]);
		assert.deepEqual(stores.studyStore.readOpen().timers, {});
	});

	it("closes already-stale timers at their last ping, not at shutdown", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w" }, T0);
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(MIN));
		closeStudyOnShutdown(plus(60 * MIN));
		assert.deepEqual(stores.studyStore.readIntervals().map((i) => [i.end, i.endReason]), [[plus(MIN).toISOString(), "idle"]]);
	});
});

describe("studyHistory", () => {
	it("summarizes stored intervals using the settings' week start and N, and reads no chat files", () => {
		const id = startedChat();
		studyFor(id, "w", 0, 30 * MIN);
		recordStudy({ type: "stop", chatId: id, windowId: "w" }, plus(30 * MIN));
		stores.chatStore.deleteChat(id);
		const summary = studyHistory("UTC", "all", plus(60 * MIN));
		assert.equal(summary.cards.totalMs, 30 * MIN);
		assert.deepEqual(summary.range.perChat, [{ chatId: id, ms: 30 * MIN }]);
		assert.equal(summary.idleMinutes, 5);
		assert.equal(summary.grid.weekStart, "monday");
		stores.settingsStore.writeSettings({ version: 1, studyTime: { weekStart: "sunday", idleMinutes: 9 } });
		const again = studyHistory("UTC", "week", plus(60 * MIN));
		assert.equal(again.grid.weekStart, "sunday");
		assert.equal(again.idleMinutes, 9);
	});

	it("closes stale timers first but does not include open ones", () => {
		const id = startedChat();
		recordStudy({ type: "active", chatId: id, windowId: "w" }, T0);
		recordStudy({ type: "active", chatId: id, windowId: "w" }, plus(2 * MIN));
		assert.equal(studyHistory("UTC", "all", plus(3 * MIN)).cards.totalMs, 0, "open timers are not included");
		assert.equal(studyHistory("UTC", "all", plus(60 * MIN)).cards.totalMs, 2 * MIN, "stale: closed at its last ping");
	});
});

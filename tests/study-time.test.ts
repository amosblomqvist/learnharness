/**
 * Study time — the pure core (docs/designs/study-time.md):
 * src/core/study-time.ts. No fs, no server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenStudyTimers, StudyInterval } from "../src/core/contracts/study.ts";
import {
	applyActive,
	applyStop,
	chatHasStarted,
	closeAllOpen,
	closeStale,
	dedupeIntervals,
	formatStudyDuration,
	isStudyInput,
	isValidTimeZone,
	parseStudyInput,
	StudyInputError,
	summarizeStudy,
} from "../src/core/study-time.ts";

const EMPTY: OpenStudyTimers = { v: 1, timers: {} };
const MIN = 60_000;
const at = (iso: string) => new Date(iso);

function interval(chatId: string, start: string, end: string, endReason: StudyInterval["endReason"] = "stop"): StudyInterval {
	return { v: 1, chatId, start, end, endReason };
}

describe("chatHasStarted", () => {
	it("needs a user or assistant message", () => {
		assert.equal(chatHasStarted([]), false);
		assert.equal(chatHasStarted([{ role: "marker" }, { role: "toolResult" }]), false);
		assert.equal(chatHasStarted([{ role: "marker" }, { role: "user" }]), true);
		assert.equal(chatHasStarted([{ role: "assistant" }]), true);
	});
});

describe("isStudyInput", () => {
	it("keyboard, click, wheel and touch scroll count", () => {
		for (const type of ["keydown", "pointerdown", "wheel", "touchmove"]) assert.equal(isStudyInput({ type }, null), true, type);
	});

	it("scroll and unknown events never count", () => {
		assert.equal(isStudyInput({ type: "scroll" }, null), false);
		assert.equal(isStudyInput({ type: "mouseover" }, null), false);
	});

	it("pointermove counts on the first event and when the screen position changed", () => {
		assert.equal(isStudyInput({ type: "pointermove", screenX: 5, screenY: 6 }, null), true);
		assert.equal(isStudyInput({ type: "pointermove", screenX: 5, screenY: 6 }, { screenX: 5, screenY: 6 }), false);
		assert.equal(isStudyInput({ type: "pointermove", screenX: 5, screenY: 7 }, { screenX: 5, screenY: 6 }), true);
	});
});

describe("parseStudyInput", () => {
	it("accepts active/stop with ids and closeAll; ignores extra keys", () => {
		assert.deepEqual(parseStudyInput({ type: "active", chatId: "a-b_1", windowId: "w1", extra: 1 }), { type: "active", chatId: "a-b_1", windowId: "w1" });
		assert.deepEqual(parseStudyInput({ type: "stop", chatId: "c", windowId: "w" }), { type: "stop", chatId: "c", windowId: "w" });
		assert.deepEqual(parseStudyInput({ type: "closeAll", chatId: 5 }), { type: "closeAll" });
	});

	it("rejects non-objects, unknown types, and bad ids", () => {
		for (const bad of [null, "x", [], 5, {}, { type: "pause" }, { type: "active" }, { type: "active", chatId: "a b", windowId: "w" }, { type: "active", chatId: "a", windowId: "" }, { type: "stop", chatId: 1, windowId: "w" }]) {
			assert.throws(() => parseStudyInput(bad), StudyInputError, JSON.stringify(bad));
		}
	});

	it("treats __proto__ as a plain id", () => {
		assert.deepEqual(parseStudyInput({ type: "active", chatId: "__proto__", windowId: "w" }), { type: "active", chatId: "__proto__", windowId: "w" });
		const step = applyActive(EMPTY, { chatId: "__proto__", windowId: "w" }, at("2026-10-28T10:00:00Z"));
		assert.deepEqual(Object.keys(step.open.timers), ["__proto__"]);
		assert.equal(applyStop(EMPTY, { chatId: "__proto__", windowId: "w" }, at("2026-10-28T10:00:00Z")).open, EMPTY);
	});
});

describe("timer transitions", () => {
	const T0 = "2026-10-28T10:00:00.000Z";

	it("active opens a timer; a same-window active only pings", () => {
		const opened = applyActive(EMPTY, { chatId: "c", windowId: "w" }, at(T0));
		assert.deepEqual(opened.open.timers.c, { start: T0, lastPing: T0, windowId: "w" });
		assert.deepEqual(opened.closed, []);
		const pinged = applyActive(opened.open, { chatId: "c", windowId: "w" }, at("2026-10-28T10:00:30.000Z"));
		assert.deepEqual(pinged.open.timers.c, { start: T0, lastPing: "2026-10-28T10:00:30.000Z", windowId: "w" });
		assert.deepEqual(pinged.closed, []);
	});

	it("stop closes this window's timer at now", () => {
		const open = applyActive(EMPTY, { chatId: "c", windowId: "w" }, at(T0)).open;
		const step = applyStop(open, { chatId: "c", windowId: "w" }, at("2026-10-28T10:40:00.000Z"));
		assert.deepEqual(step.closed, [interval("c", T0, "2026-10-28T10:40:00.000Z", "stop")]);
		assert.deepEqual(step.open.timers, {});
	});

	it("stop with no timer, or from another window, changes nothing", () => {
		assert.equal(applyStop(EMPTY, { chatId: "c", windowId: "w" }, at(T0)).open, EMPTY);
		const open = applyActive(EMPTY, { chatId: "c", windowId: "w1" }, at(T0)).open;
		const step = applyStop(open, { chatId: "c", windowId: "w2" }, at("2026-10-28T10:10:00.000Z"));
		assert.equal(step.open, open);
		assert.deepEqual(step.closed, []);
	});

	it("another window's active closes the old timer at its lastPing and opens a new one", () => {
		let open = applyActive(EMPTY, { chatId: "c", windowId: "w1" }, at(T0)).open;
		open = applyActive(open, { chatId: "c", windowId: "w1" }, at("2026-10-28T10:02:00.000Z")).open;
		const step = applyActive(open, { chatId: "c", windowId: "w2" }, at("2026-10-28T10:04:00.000Z"));
		assert.deepEqual(step.closed, [interval("c", T0, "2026-10-28T10:02:00.000Z", "idle")]);
		assert.deepEqual(step.open.timers.c, { start: "2026-10-28T10:04:00.000Z", lastPing: "2026-10-28T10:04:00.000Z", windowId: "w2" });
	});

	it("closeStale closes only timers more than N minutes old, at their lastPing", () => {
		let open = applyActive(EMPTY, { chatId: "old", windowId: "w" }, at(T0)).open;
		open = applyActive(open, { chatId: "old", windowId: "w" }, at("2026-10-28T10:01:00.000Z")).open;
		open = applyActive(open, { chatId: "fresh", windowId: "w" }, at("2026-10-28T10:05:30.000Z")).open;
		const step = closeStale(open, at("2026-10-28T10:06:01.000Z"), 5 * MIN);
		assert.deepEqual(step.closed, [interval("old", T0, "2026-10-28T10:01:00.000Z", "idle")]);
		assert.deepEqual(Object.keys(step.open.timers), ["fresh"]);
		assert.equal(closeStale(open, at("2026-10-28T10:06:00.000Z"), 5 * MIN).closed.length, 0, "exactly N minutes is not yet stale");
	});

	it("a chat closed as stale gets a new timer, never the old one reopened", () => {
		const open = applyActive(EMPTY, { chatId: "c", windowId: "w" }, at(T0)).open;
		const stale = closeStale(open, at("2026-10-28T10:30:00.000Z"), 5 * MIN);
		const next = applyActive(stale.open, { chatId: "c", windowId: "w" }, at("2026-10-28T10:30:00.000Z"));
		assert.equal(next.open.timers.c?.start, "2026-10-28T10:30:00.000Z");
	});

	it("zero-length intervals are never produced", () => {
		const open = applyActive(EMPTY, { chatId: "c", windowId: "w" }, at(T0)).open;
		assert.deepEqual(applyStop(open, { chatId: "c", windowId: "w" }, at(T0)).closed, []);
		assert.deepEqual(closeStale(open, at("2026-10-28T11:00:00.000Z"), 5 * MIN).closed, [], "never pinged again: start == lastPing");
		assert.deepEqual(applyActive(open, { chatId: "c", windowId: "other" }, at("2026-10-28T10:01:00.000Z")).closed, []);
	});

	it("closeAllOpen closes every timer with the given end reason", () => {
		let open = applyActive(EMPTY, { chatId: "a", windowId: "w" }, at(T0)).open;
		open = applyActive(open, { chatId: "b", windowId: "w" }, at(T0)).open;
		for (const reason of ["stop", "shutdown"] as const) {
			const step = closeAllOpen(open, at("2026-10-28T10:20:00.000Z"), reason);
			assert.deepEqual(step.open.timers, {});
			assert.deepEqual(step.closed.map((i) => [i.chatId, i.endReason, i.end]), [
				["a", reason, "2026-10-28T10:20:00.000Z"],
				["b", reason, "2026-10-28T10:20:00.000Z"],
			]);
		}
		assert.equal(closeAllOpen(EMPTY, at(T0), "stop").open, EMPTY);
	});
});

describe("dedupeIntervals", () => {
	it("keeps one interval per (chatId, start), the latest end; order preserved", () => {
		const list = [
			interval("a", "2026-10-28T10:00:00.000Z", "2026-10-28T10:10:00.000Z"),
			interval("b", "2026-10-28T10:00:00.000Z", "2026-10-28T10:05:00.000Z"),
			interval("a", "2026-10-28T10:00:00.000Z", "2026-10-28T10:20:00.000Z"),
			interval("a", "2026-10-28T10:00:00.000Z", "2026-10-28T10:15:00.000Z"),
		];
		assert.deepEqual(dedupeIntervals(list), [
			interval("a", "2026-10-28T10:00:00.000Z", "2026-10-28T10:20:00.000Z"),
			interval("b", "2026-10-28T10:00:00.000Z", "2026-10-28T10:05:00.000Z"),
		]);
	});
});

describe("summarizeStudy", () => {
	const NOW = at("2026-10-28T12:00:00.000Z"); // a Wednesday
	const base = { tz: "UTC", weekStart: "monday" as const, range: "week" as const, now: NOW, idleMinutes: 5 };
	const sum = (intervals: StudyInterval[], over: Partial<Parameters<typeof summarizeStudy>[0]> = {}) =>
		summarizeStudy({ ...base, intervals, ...over });
	const dayMs = (s: ReturnType<typeof summarizeStudy>, date: string) => s.grid.days.find((d) => d.date === date)?.ms;

	it("empty history: zero cards, empty charts, a full grid", () => {
		const s = sum([]);
		assert.deepEqual(s.cards, { todayMs: 0, weekMs: 0, totalMs: 0 });
		assert.deepEqual(s.range.perChat, []);
		assert.equal(s.range.hours.length, 24);
		assert.ok(s.grid.days.every((d) => d.level === 0));
		assert.equal(s.idleMinutes, 5);
	});

	it("splits an interval at local midnight", () => {
		const s = sum([interval("a", "2026-10-27T23:30:00.000Z", "2026-10-28T00:30:00.000Z")]);
		assert.equal(dayMs(s, "2026-10-27"), 30 * MIN);
		assert.equal(dayMs(s, "2026-10-28"), 30 * MIN);
		assert.equal(s.cards.todayMs, 30 * MIN);
		assert.equal(s.cards.totalMs, 60 * MIN);
		assert.equal(s.range.hours[23], 30 * MIN);
		assert.equal(s.range.hours[0], 30 * MIN);
	});

	it("handles the Europe/Lisbon spring-forward night", () => {
		// 2026-03-29 01:00Z: 01:00 WET → 02:00 WEST
		const s = sum([interval("a", "2026-03-29T00:30:00.000Z", "2026-03-29T02:30:00.000Z")], { tz: "Europe/Lisbon", range: "all" });
		assert.deepEqual(s.range.hours.slice(0, 5), [30 * MIN, 0, 60 * MIN, 30 * MIN, 0]);
		assert.equal(dayMs(s, "2026-03-29"), 120 * MIN);
		assert.equal(s.cards.totalMs, 120 * MIN);
	});

	it("handles the Europe/Lisbon fall-back night", () => {
		// 2026-10-25 01:00Z: 02:00 WEST → 01:00 WET, so local hour 1 happens twice
		const s = sum([interval("a", "2026-10-25T00:30:00.000Z", "2026-10-25T02:30:00.000Z")], { tz: "Europe/Lisbon", range: "all" });
		assert.deepEqual(s.range.hours.slice(0, 4), [0, 90 * MIN, 30 * MIN, 0]);
		assert.equal(dayMs(s, "2026-10-25"), 120 * MIN);
	});

	it("handles a half-hour-offset zone (Asia/Kolkata)", () => {
		const s = sum([interval("a", "2026-10-27T18:00:00.000Z", "2026-10-27T19:00:00.000Z")], { tz: "Asia/Kolkata" });
		assert.equal(dayMs(s, "2026-10-27"), 30 * MIN);
		assert.equal(dayMs(s, "2026-10-28"), 30 * MIN);
		assert.equal(s.range.hours[23], 30 * MIN);
		assert.equal(s.range.hours[0], 30 * MIN);
	});

	it("weeks start on Monday or Sunday", () => {
		const sunday = interval("a", "2026-10-25T10:00:00.000Z", "2026-10-25T11:00:00.000Z");
		const monday = interval("a", "2026-10-26T10:00:00.000Z", "2026-10-26T11:00:00.000Z");
		const mon = sum([sunday, monday]);
		assert.equal(mon.cards.weekMs, 60 * MIN);
		assert.equal(mon.range.perChat[0]?.ms, 60 * MIN);
		const sun = sum([sunday, monday], { weekStart: "sunday" });
		assert.equal(sun.cards.weekMs, 120 * MIN);
		assert.equal(sun.grid.weekStart, "sunday");
		assert.equal(new Date(`${mon.grid.days[0]?.date}T00:00:00Z`).getUTCDay(), 1);
		assert.equal(new Date(`${sun.grid.days[0]?.date}T00:00:00Z`).getUTCDay(), 0);
	});

	it("range windows: month from the 1st, last7 = today + 6, last30 = today + 29, all", () => {
		const day = (d: string) => interval("a", `${d}T10:00:00.000Z`, `${d}T11:00:00.000Z`);
		const list = [day("2026-09-28"), day("2026-09-29"), day("2026-09-30"), day("2026-10-01"), day("2026-10-21"), day("2026-10-22"), day("2026-10-26")];
		const hours = (range: "week" | "month" | "last7" | "last30" | "all") =>
			sum(list, { range }).range.perChat.reduce((acc, c) => acc + c.ms, 0) / (60 * MIN);
		assert.equal(hours("week"), 1); // 10-26
		assert.equal(hours("month"), 4); // 10-01, 10-21, 10-22, 10-26
		assert.equal(hours("last7"), 2); // 10-22 (today-6), 10-26
		assert.equal(hours("last30"), 6); // from 09-29
		assert.equal(hours("all"), 7);
		for (const range of ["week", "month", "last7", "last30", "all"] as const) {
			const s = sum(list, { range });
			assert.equal(s.range.key, range);
			assert.equal(s.cards.totalMs, 7 * 60 * MIN);
			assert.equal(s.cards.weekMs, 60 * MIN);
		}
	});

	it("grid: 52 week columns ending today, ascending, levels scaled to the busiest day", () => {
		const s = sum([
			interval("a", "2026-10-26T10:00:00.000Z", "2026-10-26T12:00:00.000Z"), // 120m = max → 4
			interval("a", "2026-10-27T10:00:00.000Z", "2026-10-27T10:30:00.000Z"), // 30m = max/4 → 1
			interval("a", "2026-10-21T10:00:00.000Z", "2026-10-21T10:31:00.000Z"), // just over max/4 → 2
			interval("a", "2026-10-20T10:00:00.000Z", "2026-10-20T11:30:00.000Z"), // 90m = 3/4 max → 3
		]);
		const days = s.grid.days;
		assert.equal(days.length, 51 * 7 + 3, "51 full weeks before this week + Mon..Wed");
		assert.equal(days.at(-1)?.date, "2026-10-28");
		assert.equal(days[0]?.date, "2025-11-03");
		assert.deepEqual(days.map((d) => d.date), [...days.map((d) => d.date)].sort());
		const level = (date: string) => days.find((d) => d.date === date)?.level;
		assert.equal(level("2026-10-26"), 4);
		assert.equal(level("2026-10-27"), 1);
		assert.equal(level("2026-10-21"), 2);
		assert.equal(level("2026-10-20"), 3);
		assert.equal(level("2026-10-28"), 0);
	});

	it("perChat is sorted by time descending, ties by chatId ascending, and omits empty chats", () => {
		const s = sum([
			interval("b", "2026-10-26T10:00:00.000Z", "2026-10-26T10:10:00.000Z"),
			interval("a", "2026-10-26T11:00:00.000Z", "2026-10-26T11:10:00.000Z"),
			interval("c", "2026-10-26T12:00:00.000Z", "2026-10-26T12:30:00.000Z"),
			interval("old", "2026-01-05T12:00:00.000Z", "2026-01-05T12:30:00.000Z"),
		]);
		assert.deepEqual(s.range.perChat, [
			{ chatId: "c", ms: 30 * MIN },
			{ chatId: "a", ms: 10 * MIN },
			{ chatId: "b", ms: 10 * MIN },
		]);
	});

	it("counts a duplicated (chatId, start) once", () => {
		const a = interval("a", "2026-10-26T10:00:00.000Z", "2026-10-26T10:10:00.000Z");
		assert.equal(sum([a, a]).cards.totalMs, 10 * MIN);
	});

	it("summarizes one year of data (100 intervals a day) in under 100 ms", () => {
		const list: StudyInterval[] = [];
		const startDay = Date.parse("2025-10-28T00:00:00Z");
		for (let d = 0; d < 365; d++) {
			for (let i = 0; i < 100; i++) {
				const start = startDay + d * 86_400_000 + i * 13 * MIN;
				list.push(interval(`chat${i % 40}`, new Date(start).toISOString(), new Date(start + 7 * MIN).toISOString()));
			}
		}
		// best of three: the suite runs files in parallel, so one run can lose its CPU slice
		let elapsed = Infinity;
		let totalMs = 0;
		for (let run = 0; run < 3; run++) {
			const t0 = performance.now();
			totalMs = sum(list, { range: "all", tz: "Europe/Lisbon" }).cards.totalMs;
			elapsed = Math.min(elapsed, performance.now() - t0);
		}
		assert.equal(totalMs, 365 * 100 * 7 * MIN);
		assert.ok(elapsed < 100, `took ${elapsed.toFixed(1)} ms`);
	});
});

describe("isValidTimeZone", () => {
	it("accepts IANA zones and rejects junk", () => {
		assert.equal(isValidTimeZone("Europe/Lisbon"), true);
		assert.equal(isValidTimeZone("UTC"), true);
		assert.equal(isValidTimeZone("Mars/Olympus"), false);
		assert.equal(isValidTimeZone(""), false);
	});
});

describe("formatStudyDuration", () => {
	it("whole hours and minutes, rounded down", () => {
		assert.equal(formatStudyDuration(0), "0m");
		assert.equal(formatStudyDuration(59_999), "0m");
		assert.equal(formatStudyDuration(25 * MIN), "25m");
		assert.equal(formatStudyDuration(108 * MIN + 59_000), "1h 48m");
		assert.equal(formatStudyDuration(120 * MIN), "2h 0m");
		assert.equal(formatStudyDuration(30 * 60 * MIN), "30h 0m");
	});
});

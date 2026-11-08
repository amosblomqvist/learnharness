/**
 * STUDY TIME — the pure rules (design: docs/designs/study-time.md). The
 * server (src/server/study.ts) applies the timer transitions and does the
 * I/O; the client tracker shares the input rule and the ping constant; the
 * history overlay formats with formatStudyDuration. Browser-safe: no node:
 * imports, no I/O, no date library (Intl only).
 */

import type {
	OpenStudyTimers,
	StudyInput,
	StudyInterval,
	StudyRangeKey,
	StudySummary,
	TimerStep,
} from "./contracts/study.ts";

/** One run of the client ping timer, in milliseconds. */
export const STUDY_PING_MS = 30_000;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const QUARTER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const GRID_WEEKS = 52;

/** A started chat has at least one user or assistant message. Called with
 *  native messages (the stored record), never the projected view. */
export function chatHasStarted(messages: readonly { role: string }[]): boolean {
	return messages.some((m) => m.role === "user" || m.role === "assistant");
}

/** The learner-input rule. `scroll` is never input (agent streaming scrolls
 *  by itself); `pointermove` counts only when the screen position changed.
 *  The caller updates `last` on every pointermove, counted or not. */
export function isStudyInput(
	event: { type: string; screenX?: number; screenY?: number },
	last: { screenX: number; screenY: number } | null,
): boolean {
	switch (event.type) {
		case "keydown":
		case "pointerdown":
		case "wheel":
		case "touchmove":
			return true;
		case "pointermove":
			return last === null || event.screenX !== last.screenX || event.screenY !== last.screenY;
		default:
			return false;
	}
}

export class StudyInputError extends Error {}

export function parseStudyInput(raw: unknown): StudyInput {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new StudyInputError("input must be an object");
	}
	const r = raw as Record<string, unknown>;
	if (r.type === "closeAll") return { type: "closeAll" };
	if (r.type !== "active" && r.type !== "stop") throw new StudyInputError("unknown input type");
	if (typeof r.chatId !== "string" || !ID_PATTERN.test(r.chatId)) throw new StudyInputError("invalid chatId");
	if (typeof r.windowId !== "string" || !ID_PATTERN.test(r.windowId)) throw new StudyInputError("invalid windowId");
	return { type: r.type, chatId: r.chatId, windowId: r.windowId };
}

// ─── Timer transitions ──────────────────────────────────────────────────────

type Timer = OpenStudyTimers["timers"][string];

function findTimer(open: OpenStudyTimers, chatId: string): Timer | undefined {
	return Object.hasOwn(open.timers, chatId) ? open.timers[chatId] : undefined;
}

/** Copy the timers map with one entry set (null = removed). defineProperty so
 *  an id like "__proto__" becomes an own key, never the prototype setter. */
function withTimer(open: OpenStudyTimers, chatId: string, timer: Timer | null): OpenStudyTimers {
	const timers: OpenStudyTimers["timers"] = { ...open.timers };
	if (timer === null) delete timers[chatId];
	else Object.defineProperty(timers, chatId, { value: timer, enumerable: true, writable: true, configurable: true });
	return { v: 1, timers };
}

/** The interval a timer closes into, or null when it would be zero-length. */
function closeInto(
	chatId: string,
	timer: Timer,
	end: string,
	endReason: StudyInterval["endReason"],
): StudyInterval | null {
	if (!(Date.parse(end) > Date.parse(timer.start))) return null;
	return { v: 1, chatId, start: timer.start, end, endReason };
}

function pushClosed(closed: StudyInterval[], interval: StudyInterval | null): void {
	if (interval) closed.push(interval);
}

/** Close every timer whose lastPing is more than idleMs before now, at its
 *  lastPing. Returns the same `open` object when nothing closed. */
export function closeStale(open: OpenStudyTimers, now: Date, idleMs: number): TimerStep {
	const cutoff = now.getTime() - idleMs;
	const closed: StudyInterval[] = [];
	let next = open;
	for (const [chatId, timer] of Object.entries(open.timers)) {
		if (Date.parse(timer.lastPing) < cutoff) {
			pushClosed(closed, closeInto(chatId, timer, timer.lastPing, "idle"));
			next = withTimer(next, chatId, null);
		}
	}
	return { open: next, closed };
}

/** Close one chat's timer at its lastPing (a different page took the chat
 *  over). Same `open` object when the chat has no timer. */
export function closeAtLastPing(open: OpenStudyTimers, chatId: string): TimerStep {
	const timer = findTimer(open, chatId);
	if (!timer) return { open, closed: [] };
	const closed: StudyInterval[] = [];
	pushClosed(closed, closeInto(chatId, timer, timer.lastPing, "idle"));
	return { open: withTimer(open, chatId, null), closed };
}

/** "active": same-window timer → ping; different-window timer → close at its
 *  lastPing and open a new one; none → open one. Does not check the chat. */
export function applyActive(
	open: OpenStudyTimers,
	input: { chatId: string; windowId: string },
	now: Date,
): TimerStep {
	const stamp = now.toISOString();
	const existing = findTimer(open, input.chatId);
	if (existing && existing.windowId === input.windowId) {
		return { open: withTimer(open, input.chatId, { ...existing, lastPing: stamp }), closed: [] };
	}
	const closed: StudyInterval[] = [];
	if (existing) pushClosed(closed, closeInto(input.chatId, existing, existing.lastPing, "idle"));
	const next = withTimer(open, input.chatId, { start: stamp, lastPing: stamp, windowId: input.windowId });
	return { open: next, closed };
}

/** "stop": closes the timer only when it belongs to this window. */
export function applyStop(
	open: OpenStudyTimers,
	input: { chatId: string; windowId: string },
	now: Date,
): TimerStep {
	const existing = findTimer(open, input.chatId);
	if (!existing || existing.windowId !== input.windowId) return { open, closed: [] };
	const closed: StudyInterval[] = [];
	pushClosed(closed, closeInto(input.chatId, existing, now.toISOString(), "stop"));
	return { open: withTimer(open, input.chatId, null), closed };
}

/** Close every open timer at `now` (desktop window close, server shutdown). */
export function closeAllOpen(open: OpenStudyTimers, now: Date, endReason: "stop" | "shutdown"): TimerStep {
	const entries = Object.entries(open.timers);
	if (!entries.length) return { open, closed: [] };
	const end = now.toISOString();
	const closed: StudyInterval[] = [];
	for (const [chatId, timer] of entries) pushClosed(closed, closeInto(chatId, timer, end, endReason));
	return { open: { v: 1, timers: {} }, closed };
}

/** One interval per (chatId, start): the one with the latest end. Order
 *  otherwise preserved (first occurrence's position). */
export function dedupeIntervals(list: StudyInterval[]): StudyInterval[] {
	const best = new Map<string, number>();
	const out: StudyInterval[] = [];
	for (const interval of list) {
		const key = `${interval.chatId}\u0000${interval.start}`;
		const at = best.get(key);
		if (at === undefined) {
			best.set(key, out.length);
			out.push(interval);
		} else if (Date.parse(interval.end) > Date.parse(out[at]!.end)) {
			out[at] = interval;
		}
	}
	return out;
}

// ─── Summary ────────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** The UTC offset (ms) of `tz` at a UTC instant. It comes from Intl
 *  (formatToParts) and is cached per 3-day block: when a block's first and
 *  last quarter-hour agree the offset is constant across it, else every
 *  quarter in the block is asked individually, so daylight-saving nights
 *  stay exact without one Intl call per quarter-hour. */
function offsetResolver(tz: string): (ms: number) => number {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const rawOffset = (ms: number): number => {
		const p: Record<string, number> = {};
		for (const part of fmt.formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value);
		return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - ms;
	};
	const BLOCK_MS = 3 * DAY_MS;
	const blocks = new Map<number, number | null>();
	const quarters = new Map<number, number>();
	// last block's answer, so a run of nearby instants skips the map lookup
	let lastBlock = Number.NaN;
	let lastConstant: number | null = null;
	return (ms) => {
		const block = Math.floor(ms / BLOCK_MS);
		if (block === lastBlock && lastConstant !== null) return lastConstant;
		let constant = blocks.get(block);
		if (constant === undefined) {
			const first = rawOffset(block * BLOCK_MS);
			constant = first === rawOffset((block + 1) * BLOCK_MS - QUARTER_MS) ? first : null;
			blocks.set(block, constant);
		}
		lastBlock = block;
		lastConstant = constant;
		if (constant !== null) return constant;
		const mark = Math.floor(ms / QUARTER_MS) * QUARTER_MS;
		let offset = quarters.get(mark);
		if (offset === undefined) {
			offset = rawOffset(mark);
			quarters.set(mark, offset);
		}
		return offset;
	};
}

function dateToDay(date: string): number {
	return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;
}

function dayToDate(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The first day (as a day number) of the week containing `day`. */
function weekStartDay(day: number, weekStart: "monday" | "sunday"): number {
	const dow = new Date(day * DAY_MS).getUTCDay(); // 0 = Sunday
	return day - (weekStart === "monday" ? (dow + 6) % 7 : dow);
}

export function summarizeStudy(args: {
	intervals: StudyInterval[];
	tz: string;
	weekStart: "monday" | "sunday";
	range: StudyRangeKey;
	now: Date;
	idleMinutes: number;
}): StudySummary {
	const { tz, weekStart, range, now, idleMinutes } = args;
	const offsetOf = offsetResolver(tz);
	const nowMs = now.getTime();
	// Days are counted as whole days since the epoch, in the viewer's local time.
	const todayDay = Math.floor((nowMs + offsetOf(nowMs)) / DAY_MS);
	const weekFirstDay = weekStartDay(todayDay, weekStart);
	const rangeFirstDay =
		range === "week"
			? weekFirstDay
			: range === "month"
				? dateToDay(`${dayToDate(todayDay).slice(0, 8)}01`)
				: range === "last7"
					? todayDay - 6
					: range === "last30"
						? todayDay - 29
						: -Infinity;

	const dayMs = new Map<number, number>();
	const chatMs = new Map<string, number>();
	const hours = new Array<number>(24).fill(0);
	let totalMs = 0;

	for (const interval of dedupeIntervals(args.intervals)) {
		const start = Date.parse(interval.start);
		const end = Date.parse(interval.end);
		if (!(end > start)) continue;
		// runs of pieces on one local day are summed before touching the maps
		let runDay = Number.NaN;
		let runMs = 0;
		let inRangeMs = 0;
		for (let a = start; a < end; ) {
			const mark = Math.floor(a / QUARTER_MS) * QUARTER_MS;
			const b = Math.min(end, mark + QUARTER_MS);
			// the local day and hour of the quarter-hour mark at or before `a`
			const local = mark + offsetOf(mark);
			const day = Math.floor(local / DAY_MS);
			const ms = b - a;
			if (day !== runDay) {
				if (runMs) dayMs.set(runDay, (dayMs.get(runDay) ?? 0) + runMs);
				runDay = day;
				runMs = 0;
			}
			runMs += ms;
			if (day >= rangeFirstDay) {
				inRangeMs += ms;
				const hour = Math.floor((local - day * DAY_MS) / 3_600_000);
				hours[hour] = (hours[hour] ?? 0) + ms;
			}
			a = b;
		}
		if (runMs) dayMs.set(runDay, (dayMs.get(runDay) ?? 0) + runMs);
		totalMs += end - start;
		if (inRangeMs) chatMs.set(interval.chatId, (chatMs.get(interval.chatId) ?? 0) + inRangeMs);
	}

	let weekMs = 0;
	for (const [day, ms] of dayMs) if (day >= weekFirstDay) weekMs += ms;

	const gridFirst = weekFirstDay - (GRID_WEEKS - 1) * 7;
	const gridDays: { date: string; ms: number }[] = [];
	let maxMs = 0;
	for (let d = gridFirst; d <= todayDay; d++) {
		const ms = dayMs.get(d) ?? 0;
		if (ms > maxMs) maxMs = ms;
		gridDays.push({ date: dayToDate(d), ms });
	}

	return {
		cards: { todayMs: dayMs.get(todayDay) ?? 0, weekMs, totalMs },
		range: {
			key: range,
			perChat: [...chatMs]
				.map(([chatId, ms]) => ({ chatId, ms }))
				.sort((x, y) => y.ms - x.ms || (x.chatId < y.chatId ? -1 : x.chatId > y.chatId ? 1 : 0)),
			hours,
		},
		grid: {
			weekStart,
			days: gridDays.map(({ date, ms }) => ({
				date,
				ms,
				level: (ms > 0 ? Math.min(4, Math.max(1, Math.ceil((4 * ms) / maxMs))) : 0) as 0 | 1 | 2 | 3 | 4,
			})),
		},
		idleMinutes,
	};
}

/** Whole minutes rounded down: "1h 48m", "2h 0m", "25m", "0m". */
export function formatStudyDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}

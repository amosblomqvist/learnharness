/**
 * Study-time contracts: the stored interval, the open-timer file, the
 * request/result shapes and the history summary the overlay renders.
 * Timestamps are Date.prototype.toISOString() strings.
 */

/** One finished span of study time for one chat (a line of intervals.jsonl). */
export interface StudyInterval {
	v: 1;
	chatId: string;
	start: string;
	end: string;
	/** Diagnostics only: "stop" = a stop request, "shutdown" = the server's
	 *  shutdown listener, "idle" = closed at its last ping. */
	endReason: "stop" | "idle" | "shutdown";
}

/** open.json: working state, not history. */
export interface OpenStudyTimers {
	v: 1;
	timers: Record<string, { start: string; lastPing: string; windowId: string }>;
}

export const STUDY_RANGE_KEYS = ["week", "month", "last7", "last30", "all"] as const;
export type StudyRangeKey = (typeof STUDY_RANGE_KEYS)[number];

export type StudyInput =
	| { type: "active" | "stop"; chatId: string; windowId: string }
	| { type: "closeAll" };

export type StudyResult =
	| { ok: true }
	| { ok: false; status: 400 | 404; error: "chat_not_started" | "chat_not_found" };

export interface StudySummary {
	cards: { todayMs: number; weekMs: number; totalMs: number };
	range: {
		key: StudyRangeKey;
		/** Largest first, ties by chatId; chats with no time in range left out. */
		perChat: { chatId: string; ms: number }[];
		/** Milliseconds per local hour (0 = 00:00–00:59), 24 entries. */
		hours: number[];
	};
	grid: {
		weekStart: "monday" | "sunday";
		/** Ascending date order. */
		days: { date: string; ms: number; level: 0 | 1 | 2 | 3 | 4 }[];
	};
	idleMinutes: number;
}

/** The return shape of every timer transition. */
export interface TimerStep {
	open: OpenStudyTimers;
	closed: StudyInterval[];
}

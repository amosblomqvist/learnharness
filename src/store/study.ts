/**
 * Study-time persistence (design: docs/designs/study-time.md): the
 * append-only history data/study/intervals.jsonl (config.STUDY_FILES) and
 * the working state data/study/open.json. Synchronous node:fs, like the
 * other stores, so one request's read-modify-write cannot interleave with
 * another's in the single server process.
 *
 * The torn-line tolerant JSONL reader is a copy of the graph ledger's
 * policy (that one is private and tied to the graph format stamp): lines
 * that fail to parse or fail the shape check are skipped, so a crash
 * mid-append never fails a read. De-duplication is core's job.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { STUDY_FILES } from "../../config.ts";
import type { OpenStudyTimers, StudyInterval } from "../core/contracts/study.ts";
import type { StudyStore } from "../core/ports.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const END_REASONS = ["stop", "idle", "shutdown"];

function isValidInterval(v: unknown): v is StudyInterval {
	if (v === null || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	return (
		r.v === 1 &&
		typeof r.chatId === "string" &&
		ID_PATTERN.test(r.chatId) &&
		typeof r.start === "string" &&
		!Number.isNaN(Date.parse(r.start)) &&
		typeof r.end === "string" &&
		!Number.isNaN(Date.parse(r.end)) &&
		typeof r.endReason === "string" &&
		END_REASONS.includes(r.endReason)
	);
}

function readIntervals(): StudyInterval[] {
	let raw: string;
	try {
		raw = fs.readFileSync(STUDY_FILES.intervals, "utf-8");
	} catch {
		return [];
	}
	const out: StudyInterval[] = [];
	let skipped = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			skipped++;
			continue;
		}
		if (isValidInterval(parsed)) out.push({ v: 1, chatId: parsed.chatId, start: parsed.start, end: parsed.end, endReason: parsed.endReason });
		else skipped++;
	}
	if (skipped) console.warn(`[study] skipped ${skipped} unreadable line(s) in intervals.jsonl`);
	return out;
}

function appendIntervals(list: StudyInterval[]): void {
	if (!list.length) return;
	fs.mkdirSync(path.dirname(STUDY_FILES.intervals), { recursive: true });
	let prefix = "";
	try {
		const size = fs.statSync(STUDY_FILES.intervals).size;
		if (size > 0) {
			const fd = fs.openSync(STUDY_FILES.intervals, "r");
			try {
				const last = Buffer.alloc(1);
				fs.readSync(fd, last, 0, 1, size - 1);
				if (last[0] !== 0x0a) prefix = "\n"; // torn last line: don't merge with the next record
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {
		/* no file yet */
	}
	fs.appendFileSync(STUDY_FILES.intervals, prefix + list.map((i) => `${JSON.stringify(i)}\n`).join(""), "utf-8");
}

function readOpen(): OpenStudyTimers {
	const empty: OpenStudyTimers = { v: 1, timers: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(STUDY_FILES.open, "utf-8"));
	} catch {
		return empty;
	}
	if (parsed === null || typeof parsed !== "object") return empty;
	const r = parsed as { v?: unknown; timers?: unknown };
	if (r.v !== 1 || r.timers === null || typeof r.timers !== "object" || Array.isArray(r.timers)) return empty;
	const timers: OpenStudyTimers["timers"] = {};
	for (const [chatId, entry] of Object.entries(r.timers as Record<string, unknown>)) {
		if (!ID_PATTERN.test(chatId) || entry === null || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (
			typeof e.start !== "string" ||
			Number.isNaN(Date.parse(e.start)) ||
			typeof e.lastPing !== "string" ||
			Number.isNaN(Date.parse(e.lastPing)) ||
			typeof e.windowId !== "string" ||
			!ID_PATTERN.test(e.windowId)
		) {
			continue;
		}
		Object.defineProperty(timers, chatId, {
			value: { start: e.start, lastPing: e.lastPing, windowId: e.windowId },
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return { v: 1, timers };
}

/** Temp file + fsync + rename: neither a crash nor a power loss leaves a
 *  half-written open.json (the graph store's rewriteLedgers pattern). */
function writeOpen(open: OpenStudyTimers): void {
	fs.mkdirSync(path.dirname(STUDY_FILES.open), { recursive: true });
	const tmp = `${STUDY_FILES.open}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeFileSync(fd, JSON.stringify(open), "utf-8");
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, STUDY_FILES.open);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}

export const studyStore: StudyStore = { readIntervals, appendIntervals, readOpen, writeOpen };

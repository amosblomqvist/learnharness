/**
 * Study-time store (docs/designs/study-time.md): src/store/study.ts against
 * a temp LH_DATA_DIR. The seam is read at config.ts load, so the env is set
 * BEFORE the dynamic imports (one process per test file).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { StudyInterval } from "../src/core/contracts/study.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-store-"));
process.env.LH_DATA_DIR = dir;
const { STUDY_FILES } = await import("../config.ts");
const { studyStore } = await import("../src/store/study.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(dir, "study"), { recursive: true, force: true }));

const rec = (chatId: string, start: string, end: string, endReason: StudyInterval["endReason"] = "stop"): StudyInterval => ({
	v: 1,
	chatId,
	start,
	end,
	endReason,
});
const A = rec("a", "2026-10-28T10:00:00.000Z", "2026-10-28T10:10:00.000Z");
const B = rec("b", "2026-10-28T11:00:00.000Z", "2026-10-28T11:10:00.000Z", "idle");

describe("study store: intervals.jsonl", () => {
	it("lives under data/study and follows LH_DATA_DIR", () => {
		assert.equal(STUDY_FILES.intervals, path.join(dir, "study", "intervals.jsonl"));
		assert.equal(STUDY_FILES.open, path.join(dir, "study", "open.json"));
	});

	it("appends and reads back in order; a missing file reads empty", () => {
		assert.deepEqual(studyStore.readIntervals(), []);
		studyStore.appendIntervals([A]);
		studyStore.appendIntervals([B]);
		assert.deepEqual(studyStore.readIntervals(), [A, B]);
	});

	it("an empty append writes nothing", () => {
		studyStore.appendIntervals([]);
		assert.equal(fs.existsSync(STUDY_FILES.intervals), false);
	});

	it("a torn last line is skipped and the next append lands intact", () => {
		studyStore.appendIntervals([A]);
		fs.appendFileSync(STUDY_FILES.intervals, '{"v":1,"chatId":"torn","sta');
		studyStore.appendIntervals([B]);
		assert.deepEqual(studyStore.readIntervals(), [A, B]);
		assert.ok(fs.readFileSync(STUDY_FILES.intervals, "utf-8").endsWith("\n"));
	});

	it("skips invalid and newer-version lines", () => {
		fs.mkdirSync(path.dirname(STUDY_FILES.intervals), { recursive: true });
		const lines = [
			JSON.stringify(A),
			JSON.stringify({ ...B, v: 2 }),
			JSON.stringify({ ...B, chatId: "bad id" }),
			JSON.stringify({ ...B, start: "not a date" }),
			JSON.stringify({ ...B, endReason: "crash" }),
			"[]",
			"null",
			"",
			JSON.stringify(B),
		];
		fs.writeFileSync(STUDY_FILES.intervals, lines.join("\n") + "\n");
		assert.deepEqual(studyStore.readIntervals(), [A, B]);
	});
});

describe("study store: open.json", () => {
	it("missing or unparseable file means no open timers", () => {
		assert.deepEqual(studyStore.readOpen(), { v: 1, timers: {} });
		fs.mkdirSync(path.dirname(STUDY_FILES.open), { recursive: true });
		fs.writeFileSync(STUDY_FILES.open, "{not json");
		assert.deepEqual(studyStore.readOpen(), { v: 1, timers: {} });
		fs.writeFileSync(STUDY_FILES.open, JSON.stringify({ v: 2, timers: { a: { start: A.start, lastPing: A.end, windowId: "w" } } }));
		assert.deepEqual(studyStore.readOpen(), { v: 1, timers: {} }, "a newer v reads as empty");
	});

	it("writeOpen replaces the file atomically and leaves no temp file", () => {
		const open = { v: 1 as const, timers: { a: { start: A.start, lastPing: A.end, windowId: "w1" } } };
		studyStore.writeOpen(open);
		assert.deepEqual(studyStore.readOpen(), open);
		studyStore.writeOpen({ v: 1, timers: {} });
		assert.deepEqual(studyStore.readOpen(), { v: 1, timers: {} });
		assert.deepEqual(fs.readdirSync(path.dirname(STUDY_FILES.open)), ["open.json"]);
	});

	it("drops malformed timer entries and keeps the good ones", () => {
		fs.mkdirSync(path.dirname(STUDY_FILES.open), { recursive: true });
		const good = { start: A.start, lastPing: A.end, windowId: "w" };
		fs.writeFileSync(
			STUDY_FILES.open,
			JSON.stringify({
				v: 1,
				timers: {
					good,
					"bad id": good,
					noStart: { lastPing: A.end, windowId: "w" },
					badPing: { ...good, lastPing: "nope" },
					badWindow: { ...good, windowId: "a b" },
					notObject: 5,
				},
			}),
		);
		assert.deepEqual(studyStore.readOpen(), { v: 1, timers: { good } });
	});
});

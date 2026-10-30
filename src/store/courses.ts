/**
 * CourseStore — the fs JSON adapter (one file per course in data/courses/).
 *
 * Implements core/ports.ts CourseStore; the record shape lives in
 * core/contracts/course.ts. Same idioms as the chat store: sync fs,
 * id-guarded filenames, tab-indented JSON, a version stamp at the one
 * write choke point and an honest refusal of newer-stamped records.
 * Wired in the composition root (src/server/stores.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { CourseStore } from "../core/ports.ts";
import type { CourseRecord, PlannerRunUsage } from "../core/contracts.ts";
import { CURRENT_COURSE_VERSION } from "../core/contracts.ts";

function courseFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid course id: ${id}`);
	return path.join(PATHS.courses, `${id}.json`);
}

/** THE WRITE CHOKE POINT: every persist carries the current version stamp. */
function writeCourse(record: CourseRecord): void {
	fs.mkdirSync(PATHS.courses, { recursive: true });
	fs.writeFileSync(courseFile(record.id), JSON.stringify({ ...record, version: CURRENT_COURSE_VERSION }, null, "\t"), "utf-8");
}

function getCourse(id: string): CourseRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(courseFile(id), "utf-8"));
	} catch {
		return null;
	}
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_COURSE_VERSION) {
		console.error(`[course ${id}] record stamped with schema version ${v} > ${CURRENT_COURSE_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as CourseRecord;
}

function listCourses(): CourseRecord[] {
	try {
		fs.mkdirSync(PATHS.courses, { recursive: true });
		return fs
			.readdirSync(PATHS.courses)
			.filter((f) => f.endsWith(".json"))
			.map((f) => getCourse(f.slice(0, -5)))
			.filter((r): r is CourseRecord => r !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

function createCourse(fields: Omit<CourseRecord, "id" | "createdAt" | "updatedAt">): CourseRecord {
	const now = new Date().toISOString();
	const record: CourseRecord = {
		...fields,
		id: `course_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		createdAt: now,
		updatedAt: now,
		version: CURRENT_COURSE_VERSION,
	};
	writeCourse(record);
	emit("courses-changed", {});
	return record;
}

function saveCourse(record: CourseRecord): CourseRecord | null {
	if (!getCourse(record.id)) return null;
	const saved: CourseRecord = { ...record, updatedAt: new Date().toISOString(), version: CURRENT_COURSE_VERSION };
	writeCourse(saved);
	emit("courses-changed", {});
	return saved;
}

function appendUsage(id: string, run: PlannerRunUsage): void {
	const record = getCourse(id);
	if (!record) return;
	// Usage is bookkeeping, not a list-shape change — silent, like the chat store's content writers.
	writeCourse({ ...record, usage: [...record.usage, run] });
}

function deleteCourse(id: string): boolean {
	try {
		fs.unlinkSync(courseFile(id));
	} catch {
		return false;
	}
	emit("courses-changed", {});
	return true;
}

export const courseStore: CourseStore = {
	listCourses,
	getCourse,
	createCourse,
	saveCourse,
	appendUsage,
	deleteCourse,
};

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emptyCourseIndex, parseCourseIndex, type CourseIndex } from "../core/course.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const COURSES_INDEX_FILE = path.join(PATHS.courses, "index.json");

export const courseStore = {
	read(): CourseIndex {
		let raw: string;
		try {
			raw = fs.readFileSync(COURSES_INDEX_FILE, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCourseIndex();
			throw error;
		}
		return parseCourseIndex(JSON.parse(raw));
	},
	write(index: CourseIndex): void {
		const valid = parseCourseIndex(index);
		fs.mkdirSync(path.dirname(COURSES_INDEX_FILE), { recursive: true });
		writeFileAtomicSync(COURSES_INDEX_FILE, `${JSON.stringify(valid, null, "\t")}\n`);
	},
};

import path from "node:path";
import { PATHS } from "../../config.ts";
import { isSafeId, type ChapterRecord } from "../core/course.ts";

export class CourseImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CourseImportError";
	}
}

export function chapterDirectory(courseId: string, chapterId: string): string {
	if (!isSafeId(courseId) || !isSafeId(chapterId)) throw new CourseImportError("Unknown course chapter.");
	const root = path.resolve(PATHS.courses, "files");
	const dir = path.resolve(root, courseId, chapterId);
	const rel = path.relative(root, dir);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new CourseImportError("Unsafe course path.");
	return dir;
}

export function chapterReadmePath(courseId: string, chapter: Pick<ChapterRecord, "id" | "readmeRel">): string {
	const dir = chapterDirectory(courseId, chapter.id);
	const abs = path.resolve(dir, ...chapter.readmeRel.split("/"));
	const rel = path.relative(dir, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new CourseImportError("Unsafe chapter file.");
	return abs;
}

/**
 * Course-pack read model and session/review writes. Chapter files stay
 * under LH_DATA_DIR; this module only reads the index and chat/graph records.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	chapterSourcePath,
	chapterStatus,
	conceptStatus,
	COURSE_PRESETS,
	graphFreshness,
	practicePrompt,
	presetById,
	reviewQueue,
	teachingPrompt,
	utcDay,
	applySm2,
	type ChapterView,
	type CoursePackSnapshot,
	type CourseRecord,
	type CourseView,
} from "../core/course.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { courseStore } from "../store/courses.ts";
import { settingsStore } from "../store/settings.ts";
import { chapterReadmePath, CourseImportError } from "./course-paths.ts";
import { stores } from "./stores.ts";

export type { CoursePackSnapshot };

function remember(ids: string[], id: string): string[] {
	return [...ids.filter((existing) => existing !== id), id].slice(-50);
}

function notesSourceId(filePath: string): string {
	// Same identity the notes importer writes: src_ + first 12 hex of sha256(path).
	return `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

function liveChatIds(): Set<string> {
	return new Set(stores.chatStore.listChats().map((chat) => chat.id));
}

function graphProvenance(): Set<string> {
	const ids = new Set<string>();
	for (const node of stores.graphStore.readNodes()) {
		for (const point of node.provenance) ids.add(point.chatId);
	}
	return ids;
}

function chapterView(course: CourseRecord, live: Set<string>, provenance: Set<string>, today: string): ChapterView[] {
	return course.chapters.map((chapter) => {
		const teachSessions = chapter.teachChatIds.filter((id) => live.has(id)).length;
		const practiceSessions = chapter.practiceChatIds.filter((id) => live.has(id)).length;
		return {
			id: chapter.id,
			order: chapter.order,
			folderName: chapter.folderName,
			title: chapter.title,
			present: chapter.present,
			imageCount: chapter.imageCount,
			status: chapterStatus({ teachSessions, practiceSessions, card: chapter.card, concepts: chapter.concepts, today }),
			inGraph: provenance.has(notesSourceId(chapterSourcePath(course.id, chapter.id))),
			graphState: graphFreshness(chapter),
			graphError: chapter.graphError,
			teachSessions,
			practiceSessions,
			due: chapter.card?.due ?? null,
			readmeFile: chapterReadmePath(course.id, chapter),
			concepts: chapter.concepts.map((concept) => ({
				id: concept.id,
				title: concept.title,
				retired: concept.retired,
				status: concept.retired ? "not_started" : conceptStatus(concept.card, today),
				due: concept.card?.due ?? null,
				repetitions: concept.card?.repetitions ?? 0,
			})),
		};
	});
}

export function coursePackSnapshot(now = new Date()): CoursePackSnapshot {
	const today = utcDay(now);
	const index = courseStore.read();
	const live = liveChatIds();
	const provenance = graphProvenance();
	const courses: CourseView[] = index.courses.map((course) => ({
		id: course.id,
		title: course.title,
		presetId: course.presetId,
		interview: presetById(course.presetId ?? "")?.interview ?? false,
		origin: course.origin,
		updatedAt: course.updatedAt,
		chapters: chapterView(course, live, provenance, today),
	}));
	return { presets: COURSE_PRESETS, courses, today: reviewQueue(index.courses, today), todayDay: today };
}

function requireChapter(courseId: string, chapterId: string): { index: ReturnType<typeof courseStore.read>; course: CourseRecord; chapterIndex: number } {
	const index = courseStore.read();
	const course = index.courses.find((item) => item.id === courseId);
	if (!course) throw new CourseImportError("That course is not imported.");
	const chapterIndex = course.chapters.findIndex((chapter) => chapter.id === chapterId);
	const chapter = course.chapters[chapterIndex];
	if (!chapter) throw new CourseImportError("That chapter is not in the course.");
	return { index, course, chapterIndex };
}

export function openChapterSession(
	courseId: string,
	chapterId: string,
	kind: "teach" | "practice",
	conceptId?: string,
): { id: string; prompt: string; pack: CoursePackSnapshot } {
	const { index, course, chapterIndex } = requireChapter(courseId, chapterId);
	const chapter = course.chapters[chapterIndex]!;
	const readmeFile = chapterReadmePath(course.id, chapter);
	if (!fs.existsSync(readmeFile)) throw new CourseImportError("The chapter file is not in local app data. Import the course again.");
	const chapterDir = path.dirname(readmeFile);
	let conceptTitle: string | undefined;
	if (conceptId) {
		const concept = chapter.concepts.find((item) => item.id === conceptId && !item.retired);
		if (!concept) throw new CourseImportError("That heading is not in the current chapter.");
		conceptTitle = concept.title;
	}
	const prompt = kind === "practice"
		? practicePrompt({
			title: chapter.title,
			folderName: chapter.folderName,
			readmePath: readmeFile,
			directory: chapterDir,
			interview: presetById(course.presetId ?? "")?.interview ?? false,
			conceptTitle,
		})
		: teachingPrompt({ title: chapter.title, folderName: chapter.folderName, readmePath: readmeFile, directory: chapterDir });
	const chat = stores.chatStore.createChat(titleFromPrompt(prompt), kind === "practice" ? "practice" : undefined);
	const strong = settingsStore.readSettings()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	if (kind === "practice") chapter.practiceChatIds = remember(chapter.practiceChatIds, chat.id);
	else chapter.teachChatIds = remember(chapter.teachChatIds, chat.id);
	course.updatedAt = new Date().toISOString();
	courseStore.write(index);
	return { id: chat.id, prompt, pack: coursePackSnapshot() };
}

export function gradeCourseItem(courseId: string, chapterId: string, grade: number, conceptId?: string, now = new Date()): CoursePackSnapshot {
	const { index, course, chapterIndex } = requireChapter(courseId, chapterId);
	const chapter = course.chapters[chapterIndex]!;
	if (conceptId) {
		const concept = chapter.concepts.find((item) => item.id === conceptId);
		if (!concept || concept.retired) throw new CourseImportError("That heading is not in the current chapter.");
		concept.card = applySm2(concept.card, grade, now);
	} else {
		chapter.card = applySm2(chapter.card, grade, now);
	}
	course.updatedAt = now.toISOString();
	courseStore.write(index);
	return coursePackSnapshot(now);
}

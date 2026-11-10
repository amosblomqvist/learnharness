/**
 * Course packs (personal fork). Pure detection, SM-2 scheduling, and status.
 * Chapter bytes never live here: the server copies them into LH_DATA_DIR.
 *
 * Scheduling is SM-2 (Wozniak, 1990), not FSRS. SM-2 is a short public
 * formula with no trained weights, so a local app can test it exactly and
 * does not need a review corpus or a network. FSRS-lite would still ship
 * someone else's default weights and more state than these reviews use.
 * Interval uses the ease from before the review; ease is updated after.
 */

import { directoryReferencePath, quoteFilePath } from "./file-paths.ts";

export const COURSE_INDEX_VERSION = 1 as const;
export const SM2_DEFAULT_EASE = 2.5;
export const SM2_MIN_EASE = 1.3;
/** A chapter is mastered once a successful review lands at least this far out. */
export const MASTERED_INTERVAL_DAYS = 21;
export const MAX_CONCEPTS = 12;

export type ChapterStatus = "not_started" | "learning" | "review_due" | "mastered";
export type GraphFreshness = "current" | "stale" | "absent" | "error";

export interface CoursePreset {
	id: string;
	title: string;
	repo: string;
	ref: string;
	/** Practice openings use the system-design interview frame. */
	interview: boolean;
	summary: string;
}

/** First preset. The notes themselves are not in this repository. */
export const COURSE_PRESETS: readonly CoursePreset[] = [
	{
		id: "system-design-notes",
		title: "System Design Notes",
		repo: "liquidslr/system-design-notes",
		ref: "main",
		interview: true,
		summary:
			"Numbered chapter folders, each with a Readme.md. The notes are not shipped with this app. Import a folder on your machine, or download the GitHub archive into local app data when you import.",
	},
];

export interface ReviewCard {
	ease: number;
	intervalDays: number;
	repetitions: number;
	/** UTC calendar day YYYY-MM-DD. Due when this is on or before today. */
	due: string;
	lastReviewed: string | null;
	lastGrade: number | null;
}

export interface ConceptRecord {
	id: string;
	title: string;
	retired: boolean;
	card: ReviewCard | null;
}

export interface ChapterRecord {
	id: string;
	order: number;
	folderName: string;
	title: string;
	present: boolean;
	contentHash: string;
	/** Posix path inside the chapter directory, usually Readme.md. */
	readmeRel: string;
	imageCount: number;
	updatedAt: string;
	/** Hash last successfully extracted into the knowledge graph. */
	extractedHash: string | null;
	graphError: string | null;
	teachChatIds: string[];
	practiceChatIds: string[];
	card: ReviewCard | null;
	concepts: ConceptRecord[];
}

export type CourseOrigin =
	| { kind: "local"; path: string }
	| { kind: "github"; repo: string; ref: string };

export interface CourseRecord {
	id: string;
	title: string;
	presetId: string | null;
	origin: CourseOrigin;
	createdAt: string;
	updatedAt: string;
	extractGraph: boolean;
	chapters: ChapterRecord[];
}

export interface CourseIndex {
	version: typeof COURSE_INDEX_VERSION;
	courses: CourseRecord[];
}

export interface ConceptView {
	id: string;
	title: string;
	retired: boolean;
	status: ChapterStatus;
	due: string | null;
	repetitions: number;
}

export interface ChapterView {
	id: string;
	order: number;
	folderName: string;
	title: string;
	present: boolean;
	imageCount: number;
	status: ChapterStatus;
	inGraph: boolean;
	graphState: GraphFreshness;
	graphError: string | null;
	teachSessions: number;
	practiceSessions: number;
	due: string | null;
	readmeFile: string;
	concepts: ConceptView[];
}

export interface CourseView {
	id: string;
	title: string;
	presetId: string | null;
	interview: boolean;
	origin: CourseOrigin;
	updatedAt: string;
	chapters: ChapterView[];
}

export interface ReviewQueueItem {
	courseId: string;
	courseTitle: string;
	chapterId: string;
	chapterTitle: string;
	conceptId: string | null;
	label: string;
	due: string;
}

export interface CoursePackSnapshot {
	presets: readonly CoursePreset[];
	courses: CourseView[];
	today: ReviewQueueItem[];
	todayDay: string;
	error?: string;
}

export function emptyCourseIndex(): CourseIndex {
	return { version: COURSE_INDEX_VERSION, courses: [] };
}

export function presetById(id: string): CoursePreset | undefined {
	return COURSE_PRESETS.find((preset) => preset.id === id);
}

export function isSafeId(id: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
}

export function slugify(text: string): string {
	const slug = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "item";
}

export function localCourseId(folderName: string, pathHash8: string): string {
	return `local-${slugify(folderName).slice(0, 60)}-${pathHash8}`;
}

/** Logical graph-source path. Stable across machines; not a disk path. */
export function chapterSourcePath(courseId: string, chapterId: string): string {
	return `courses/${courseId}/${chapterId}/Readme.md`;
}

export function githubArchiveUrl(repo: string, ref: string): string {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Unsupported repository name.");
	if (!/^[\w.-]+$/.test(ref)) throw new Error("Unsupported git ref.");
	return `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`;
}

/** Leading number plus a separator, so "01. Boxes" is chapter 1. */
export function chapterOrder(folderName: string): number | null {
	const match = /^(\d{1,4})(?:$|[.\s_-])/.exec(folderName);
	if (!match) return null;
	const order = Number(match[1]);
	return Number.isInteger(order) ? order : null;
}

export function detectChapters(paths: readonly string[]): { order: number; folderName: string; readmePath: string }[] {
	const byFolder = new Map<string, string[]>();
	for (const filePath of paths) {
		if (filePath.startsWith("/") || filePath.split("/").includes("..")) continue;
		const parts = filePath.split("/");
		if (parts.length < 2) continue;
		const folder = parts[0];
		if (!folder || chapterOrder(folder) === null) continue;
		const list = byFolder.get(folder) ?? [];
		list.push(filePath);
		byFolder.set(folder, list);
	}
	const found: { order: number; folderName: string; readmePath: string }[] = [];
	for (const [folder, files] of byFolder) {
		const readme = files.find((file) => {
			const rest = file.slice(folder.length + 1);
			return !rest.includes("/") && /^readme\.md$/i.test(rest);
		});
		const order = chapterOrder(folder);
		if (!readme || order === null) continue;
		found.push({ order, folderName: folder, readmePath: readme });
	}
	found.sort((a, b) => a.order - b.order || a.folderName.localeCompare(b.folderName));
	return found;
}

export function assignChapterIds(chapters: readonly { order: number; folderName: string }[]): string[] {
	const counts = new Map<number, number>();
	for (const chapter of chapters) counts.set(chapter.order, (counts.get(chapter.order) ?? 0) + 1);
	const seen = new Map<number, number>();
	return chapters.map((chapter) => {
		const num = String(chapter.order).padStart(2, "0");
		if ((counts.get(chapter.order) ?? 0) === 1) return `n-${num}`;
		const nth = (seen.get(chapter.order) ?? 0) + 1;
		seen.set(chapter.order, nth);
		return `n-${num}-${slugify(chapter.folderName)}`.slice(0, 80);
	});
}

export function isChapterImage(relFromChapter: string): boolean {
	if (relFromChapter.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
	return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(relFromChapter);
}

export function chapterTitle(markdown: string, folderName: string): string {
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^#[ \t]+(.+?)\s*#*\s*$/.exec(line);
		const title = match?.[1]?.trim();
		if (title) return title.slice(0, 160);
	}
	return folderName.replace(/^\d{1,4}[.\s_-]+/, "").trim() || folderName;
}

export function conceptHeadings(markdown: string): { id: string; title: string }[] {
	const out: { id: string; title: string }[] = [];
	const seen = new Set<string>();
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^##[ \t]+(.+?)\s*#*\s*$/.exec(line);
		const title = match?.[1]?.replace(/\s+#+\s*$/, "").trim();
		if (!title || title.length > 120) continue;
		let id = slugify(title).slice(0, 60);
		if (seen.has(id)) {
			let n = 2;
			while (seen.has(`${id}-${n}`)) n += 1;
			id = `${id}-${n}`;
		}
		seen.add(id);
		out.push({ id, title });
		if (out.length >= MAX_CONCEPTS) break;
	}
	return out;
}

export function mergeConcepts(previous: readonly ConceptRecord[], headings: readonly { id: string; title: string }[]): ConceptRecord[] {
	const nextIds = new Set(headings.map((heading) => heading.id));
	const prevById = new Map(previous.map((concept) => [concept.id, concept]));
	const active: ConceptRecord[] = headings.map((heading) => ({
		id: heading.id,
		title: heading.title,
		retired: false,
		card: prevById.get(heading.id)?.card ?? null,
	}));
	const retired = previous.filter((concept) => !nextIds.has(concept.id)).map((concept) => ({ ...concept, retired: true }));
	return [...active, ...retired];
}

export function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, days: number): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) throw new Error("Expected a UTC day.");
	const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return new Date(stamp + days * 86_400_000).toISOString().slice(0, 10);
}

export function applySm2(card: ReviewCard | null, grade: number, now: Date): ReviewCard {
	if (!Number.isInteger(grade) || grade < 0 || grade > 5) throw new Error("Grade must be an integer from 0 to 5.");
	const ease0 = card?.ease ?? SM2_DEFAULT_EASE;
	const reps0 = card?.repetitions ?? 0;
	let repetitions = reps0;
	let interval = card?.intervalDays ?? 0;
	if (grade < 3) {
		repetitions = 0;
		interval = 1;
	} else if (repetitions === 0) {
		interval = 1;
		repetitions = 1;
	} else if (repetitions === 1) {
		interval = 6;
		repetitions = 2;
	} else {
		interval = Math.max(1, Math.round(interval * ease0));
		repetitions += 1;
	}
	const miss = 5 - grade;
	let ease = ease0 + (0.1 - miss * (0.08 + miss * 0.02));
	if (ease < SM2_MIN_EASE) ease = SM2_MIN_EASE;
	ease = Math.round(ease * 10_000) / 10_000;
	const today = utcDay(now);
	return {
		ease,
		intervalDays: interval,
		repetitions,
		due: addUtcDays(today, interval),
		lastReviewed: now.toISOString(),
		lastGrade: grade,
	};
}

export function isDue(card: ReviewCard | null, today: string): boolean {
	return card !== null && card.due <= today;
}

export function isMastered(card: ReviewCard | null, today: string): boolean {
	if (!card || card.lastGrade === null) return false;
	return card.lastGrade >= 4 && card.repetitions >= 3 && card.intervalDays >= MASTERED_INTERVAL_DAYS && card.due > today;
}

export function graphFreshness(chapter: { contentHash: string; extractedHash: string | null; graphError: string | null }): GraphFreshness {
	if (chapter.extractedHash && chapter.extractedHash === chapter.contentHash) return "current";
	if (chapter.graphError) return "error";
	if (chapter.extractedHash) return "stale";
	return "absent";
}

/**
 * Status is the learner's record, not the graph's. The graph stores
 * propositions, not mastery, so imported nodes alone stay "not started".
 * A due card wins over mastered: the review is the thing to do today.
 * Unreviewed headings do not block mastery; a heading you graded does.
 */
export function chapterStatus(input: {
	teachSessions: number;
	practiceSessions: number;
	card: ReviewCard | null;
	concepts: readonly { retired: boolean; card: ReviewCard | null }[];
	today: string;
}): ChapterStatus {
	const active = input.concepts.filter((concept) => !concept.retired);
	const due = isDue(input.card, input.today) || active.some((concept) => isDue(concept.card, input.today));
	if (due) return "review_due";
	const gradedConcepts = active.map((concept) => concept.card).filter((card): card is ReviewCard => card !== null);
	if (isMastered(input.card, input.today) && gradedConcepts.every((card) => isMastered(card, input.today))) return "mastered";
	if (input.teachSessions > 0 || input.practiceSessions > 0 || input.card !== null || gradedConcepts.length > 0) return "learning";
	return "not_started";
}

export function conceptStatus(card: ReviewCard | null, today: string): ChapterStatus {
	if (isDue(card, today)) return "review_due";
	if (isMastered(card, today)) return "mastered";
	if (card) return "learning";
	return "not_started";
}

export function reviewQueue(
	courses: readonly {
		id: string;
		title: string;
		chapters: readonly {
			id: string;
			title: string;
			order: number;
			present: boolean;
			card: ReviewCard | null;
			concepts: readonly { id: string; title: string; retired: boolean; card: ReviewCard | null }[];
		}[];
	}[],
	today: string,
): ReviewQueueItem[] {
	const items: (ReviewQueueItem & { order: number })[] = [];
	for (const course of courses) {
		for (const chapter of course.chapters) {
			if (!chapter.present) continue;
			if (isDue(chapter.card, today) && chapter.card) {
				items.push({
					courseId: course.id,
					courseTitle: course.title,
					chapterId: chapter.id,
					chapterTitle: chapter.title,
					conceptId: null,
					label: chapter.title,
					due: chapter.card.due,
					order: chapter.order,
				});
			}
			for (const concept of chapter.concepts) {
				if (concept.retired || !isDue(concept.card, today) || !concept.card) continue;
				items.push({
					courseId: course.id,
					courseTitle: course.title,
					chapterId: chapter.id,
					chapterTitle: chapter.title,
					conceptId: concept.id,
					label: concept.title,
					due: concept.card.due,
					order: chapter.order,
				});
			}
		}
	}
	items.sort((a, b) => a.due.localeCompare(b.due) || a.order - b.order || a.label.localeCompare(b.label));
	return items.map(({ order: _order, ...item }) => item);
}

export function teachingPrompt(input: { title: string; folderName: string; readmePath: string; directory: string }): string {
	const file = quoteFilePath(input.readmePath);
	const directory = directoryReferencePath(input.directory);
	return [
		`Teach me this chapter from my notes: ${input.title} (${input.folderName}).`,
		`Read ${file} and use the images in ${directory} when they help.`,
		"Run the usual loop: measure what I already understand, then plan, then teach.",
		"The notes are the source material. Do not assume I have read them.",
	].join("\n\n");
}

export function practicePrompt(input: {
	title: string;
	folderName: string;
	readmePath: string;
	directory: string;
	interview: boolean;
	conceptTitle?: string;
}): string {
	const file = quoteFilePath(input.readmePath);
	const directory = directoryReferencePath(input.directory);
	const focus = input.conceptTitle ? `Focus the problem on this heading from the notes: ${input.conceptTitle}.` : "";
	if (input.interview) {
		return [
			`Practice a system design interview using this chapter's notes as the only source: ${input.title} (${input.folderName}).`,
			`Read ${file} first. Images are in ${directory}.`,
			focus,
			"Pose one open-ended interview prompt grounded in the chapter. Let me drive each step before you add anything:",
			"1. Requirements",
			"2. Estimation",
			"3. High-level design",
			"4. Deep dive",
			"5. Wrap-up",
			"Do not recite the chapter. Do not show the reference design until the problem is concluded. Use the notes to decide what a sound answer must cover.",
		].filter((line) => line.length > 0).join("\n\n");
	}
	return [
		`Practice the ideas in this chapter. The material is the notes, not a new topic: ${input.title} (${input.folderName}).`,
		`Read ${file} before posing a problem. Images are in ${directory}.`,
		focus,
		"Pose open problems that make the chapter's ideas come to mind without naming them first. Vary the situation. Wait for me between problems.",
	].filter((line) => line.length > 0).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isDay(value: unknown): value is string {
	return isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseCard(value: unknown): ReviewCard | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new Error("Course review card is invalid.");
	const { ease, intervalDays, repetitions, due, lastReviewed, lastGrade } = value;
	if (typeof ease !== "number" || !Number.isFinite(ease) || ease < SM2_MIN_EASE) throw new Error("Course review ease is invalid.");
	if (!Number.isInteger(intervalDays) || (intervalDays as number) < 0) throw new Error("Course review interval is invalid.");
	if (!Number.isInteger(repetitions) || (repetitions as number) < 0) throw new Error("Course review repetitions are invalid.");
	if (!isDay(due)) throw new Error("Course review due date is invalid.");
	if (lastReviewed !== null && !isString(lastReviewed)) throw new Error("Course review timestamp is invalid.");
	if (lastGrade !== null && (!Number.isInteger(lastGrade) || (lastGrade as number) < 0 || (lastGrade as number) > 5)) {
		throw new Error("Course review grade is invalid.");
	}
	return {
		ease,
		intervalDays: intervalDays as number,
		repetitions: repetitions as number,
		due,
		lastReviewed: lastReviewed as string | null,
		lastGrade: lastGrade as number | null,
	};
}

function parseConcept(value: unknown): ConceptRecord {
	if (!isRecord(value) || !isString(value.id) || !isSafeId(value.id) || !isString(value.title) || typeof value.retired !== "boolean") {
		throw new Error("Course concept is invalid.");
	}
	return { id: value.id, title: value.title, retired: value.retired, card: parseCard(value.card) };
}

function parseChapter(value: unknown): ChapterRecord {
	if (!isRecord(value)) throw new Error("Course chapter is invalid.");
	const readmeRel = value.readmeRel;
	if (!isString(readmeRel) || readmeRel.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new Error("Course chapter file is invalid.");
	}
	if (!isString(value.id) || !isSafeId(value.id) || !Number.isInteger(value.order) || !isString(value.folderName) || !isString(value.title)) {
		throw new Error("Course chapter identity is invalid.");
	}
	if (typeof value.present !== "boolean" || !isString(value.contentHash) || !Number.isInteger(value.imageCount)) {
		throw new Error("Course chapter record is invalid.");
	}
	if (!isString(value.updatedAt) || (value.extractedHash !== null && !isString(value.extractedHash))) {
		throw new Error("Course chapter timestamps are invalid.");
	}
	if (value.graphError !== null && !isString(value.graphError)) throw new Error("Course chapter graph error is invalid.");
	if (!Array.isArray(value.teachChatIds) || !Array.isArray(value.practiceChatIds) || !value.teachChatIds.every(isString) || !value.practiceChatIds.every(isString)) {
		throw new Error("Course chapter sessions are invalid.");
	}
	if (!Array.isArray(value.concepts)) throw new Error("Course concepts are invalid.");
	return {
		id: value.id,
		order: value.order as number,
		folderName: value.folderName,
		title: value.title,
		present: value.present,
		contentHash: value.contentHash,
		readmeRel,
		imageCount: value.imageCount as number,
		updatedAt: value.updatedAt,
		extractedHash: value.extractedHash as string | null,
		graphError: value.graphError as string | null,
		teachChatIds: value.teachChatIds,
		practiceChatIds: value.practiceChatIds,
		card: parseCard(value.card),
		concepts: value.concepts.map(parseConcept),
	};
}

function parseOrigin(value: unknown): CourseOrigin {
	if (!isRecord(value)) throw new Error("Course origin is invalid.");
	if (value.kind === "local" && isString(value.path) && value.path.length > 0) return { kind: "local", path: value.path };
	if (value.kind === "github" && isString(value.repo) && isString(value.ref)) return { kind: "github", repo: value.repo, ref: value.ref };
	throw new Error("Course origin is invalid.");
}

function parseCourse(value: unknown): CourseRecord {
	if (!isRecord(value) || !isString(value.id) || !isSafeId(value.id) || !isString(value.title)) throw new Error("Course record is invalid.");
	if (value.presetId !== null && !isString(value.presetId)) throw new Error("Course preset is invalid.");
	if (!isString(value.createdAt) || !isString(value.updatedAt) || typeof value.extractGraph !== "boolean" || !Array.isArray(value.chapters)) {
		throw new Error("Course record is invalid.");
	}
	return {
		id: value.id,
		title: value.title,
		presetId: value.presetId as string | null,
		origin: parseOrigin(value.origin),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		extractGraph: value.extractGraph,
		chapters: value.chapters.map(parseChapter),
	};
}

export function parseCourseIndex(value: unknown): CourseIndex {
	if (!isRecord(value) || value.version !== COURSE_INDEX_VERSION || !Array.isArray(value.courses)) {
		throw new Error("Course index is not version 1.");
	}
	return { version: COURSE_INDEX_VERSION, courses: value.courses.map(parseCourse) };
}

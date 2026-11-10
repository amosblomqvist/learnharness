/**
 * Copy a course source into local app data and, when asked, run the
 * existing notes extractor on chapters whose bytes changed.
 * The source tree is never written into the git repository.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PATHS } from "../../config.ts";
import { extraction } from "./chat-handler.ts";
import { sourceDirectory } from "./source-organization.ts";
import {
	assignChapterIds,
	chapterSourcePath,
	chapterTitle,
	conceptHeadings,
	detectChapters,
	githubArchiveUrl,
	isChapterImage,
	isSafeId,
	localCourseId,
	mergeConcepts,
	presetById,
	type ChapterRecord,
	type CourseOrigin,
	type CourseRecord,
} from "../core/course.ts";
import { courseStore } from "../store/courses.ts";
import { chapterDirectory, CourseImportError } from "./course-paths.ts";
import { coursePackSnapshot, type CoursePackSnapshot } from "./courses.ts";

export { CourseImportError };

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_README_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface CourseImportRequest {
	presetId?: string;
	localPath?: string;
	download?: boolean;
	courseId?: string;
	extractGraph?: boolean;
}

export interface CourseImportOutcome {
	pack: CoursePackSnapshot;
	courseId: string;
	copied: number;
	unchanged: number;
	extracted: number;
	warnings: string[];
}

interface ImportDeps {
	importNotes?: (input: { filePath: string; text: string }) => Promise<{ nodes: number }>;
	registerImport?: (filePath: string) => void;
	fetchArchive?: (url: string) => Promise<Buffer>;
	now?: () => Date;
}

interface ChapterFiles {
	readmeRel: string;
	readme: Buffer;
	images: { rel: string; bytes: Buffer }[];
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const abs = path.join(current.dir, entry.name);
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(abs);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (current.depth < 6) stack.push({ dir: abs, depth: current.depth + 1 });
				continue;
			}
			if (!stat.isFile()) continue;
			const rel = path.relative(root, abs).split(path.sep).join("/");
			if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) continue;
			out.push(rel);
		}
	}
	return out;
}

function resolveLocalRoot(input: string): string {
	if (!path.isAbsolute(input)) throw new CourseImportError("Use the full path to the notes folder.");
	let real: string;
	try {
		real = fs.realpathSync(path.resolve(input));
	} catch {
		throw new CourseImportError("That folder does not exist.");
	}
	if (!fs.statSync(real).isDirectory()) throw new CourseImportError("That path is not a folder.");
	const coursesRoot = path.resolve(PATHS.courses);
	const rel = path.relative(coursesRoot, real);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
		throw new CourseImportError("Choose a folder outside the app's course data directory.");
	}
	return real;
}

function findCourseRoot(dest: string): string {
	if (detectChapters(listFiles(dest)).length > 0) return dest;
	const kids = fs.readdirSync(dest, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
	if (kids.length === 1) {
		const nested = path.join(dest, kids[0]!.name);
		if (detectChapters(listFiles(nested)).length > 0) return nested;
	}
	return dest;
}

async function downloadArchive(url: string, fetchArchive: (url: string) => Promise<Buffer>): Promise<string> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-"));
	try {
		const bytes = await fetchArchive(url);
		if (bytes.length > MAX_ARCHIVE_BYTES) throw new CourseImportError("The notes archive is larger than 120 MB.");
		const archive = path.join(tmp, "archive.tar.gz");
		const dest = path.join(tmp, "extract");
		fs.writeFileSync(archive, bytes);
		fs.mkdirSync(dest);
		await execFileAsync("tar", ["-xf", archive, "-C", dest], { timeout: 120_000 });
		const root = findCourseRoot(dest);
		const kept = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-root-"));
		fs.cpSync(root, kept, { recursive: true, dereference: false });
		return kept;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function defaultFetch(url: string): Promise<Buffer> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new CourseImportError(`Could not download the notes archive (${response.status}). Import a local clone instead.`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new CourseImportError("The download had no body.");
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_ARCHIVE_BYTES) throw new CourseImportError("The notes archive is larger than 120 MB.");
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

function hashChapter(readmeRel: string, readme: Buffer, images: { rel: string; bytes: Buffer }[]): string {
	const hash = createHash("sha256");
	const files = [{ rel: readmeRel, bytes: readme }, ...images].sort((a, b) => a.rel.localeCompare(b.rel));
	for (const file of files) {
		hash.update(file.rel);
		hash.update("\0");
		hash.update(file.bytes);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function readChapter(root: string, folder: string, readmePath: string, warnings: string[]): ChapterFiles | null {
	const readmeAbs = path.join(root, ...readmePath.split("/"));
	let readme: Buffer;
	try {
		readme = fs.readFileSync(readmeAbs);
	} catch {
		warnings.push(`${folder}: could not read the chapter file.`);
		return null;
	}
	if (readme.includes(0) || readme.length > MAX_README_BYTES) {
		warnings.push(`${folder}: Readme.md is not usable text under 2 MB, so this chapter was left unchanged.`);
		return null;
	}
	const prefix = `${folder}/`;
	const images: { rel: string; bytes: Buffer }[] = [];
	for (const relPath of listFiles(root)) {
		if (!relPath.startsWith(prefix) || relPath === readmePath) continue;
		const rel = relPath.slice(prefix.length);
		if (!isChapterImage(rel)) continue;
		const abs = path.join(root, ...relPath.split("/"));
		let bytes: Buffer;
		try {
			bytes = fs.readFileSync(abs);
		} catch {
			warnings.push(`${folder}: skipped unreadable image ${rel}.`);
			continue;
		}
		if (bytes.length > MAX_IMAGE_BYTES) {
			warnings.push(`${folder}: skipped ${rel} because it is larger than 8 MB.`);
			continue;
		}
		images.push({ rel, bytes });
	}
	const readmeRel = readmePath.slice(prefix.length);
	return { readmeRel, readme, images };
}

function writeChapter(dir: string, files: ChapterFiles): void {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const readmePath = path.join(dir, ...files.readmeRel.split("/"));
	fs.mkdirSync(path.dirname(readmePath), { recursive: true });
	fs.writeFileSync(readmePath, files.readme);
	for (const image of files.images) {
		const target = path.join(dir, ...image.rel.split("/"));
		const rel = path.relative(dir, target);
		if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, image.bytes);
	}
}

function remember(ids: string[], id: string): string[] {
	return [...ids.filter((existing) => existing !== id), id].slice(-50);
}

export async function importCourse(request: CourseImportRequest, deps: ImportDeps = {}): Promise<CourseImportOutcome> {
	const now = (deps.now ?? (() => new Date()))();
	const index = courseStore.read();
	const existing = request.courseId ? index.courses.find((course) => course.id === request.courseId) : undefined;
	if (request.courseId && !existing) throw new CourseImportError("That course is not imported.");
	const presetId = request.presetId ?? existing?.presetId ?? undefined;
	const preset = presetId ? presetById(presetId) : undefined;
	if (presetId && !preset) throw new CourseImportError("Unknown course preset.");

	let origin: CourseOrigin;
	let cleanup: string | null = null;
	let root: string;
	if (request.localPath) {
		root = resolveLocalRoot(request.localPath);
		origin = { kind: "local", path: root };
	} else if (request.download || existing?.origin.kind === "github") {
		const repo = preset?.repo ?? (existing?.origin.kind === "github" ? existing.origin.repo : "");
		const ref = preset?.ref ?? (existing?.origin.kind === "github" ? existing.origin.ref : "");
		if (!repo || !ref) throw new CourseImportError("Download needs a known course preset.");
		origin = { kind: "github", repo, ref };
		const url = githubArchiveUrl(repo, ref);
		cleanup = await downloadArchive(url, deps.fetchArchive ?? defaultFetch);
		root = cleanup;
	} else if (existing?.origin.kind === "local") {
		root = resolveLocalRoot(existing.origin.path);
		origin = { kind: "local", path: root };
	} else {
		throw new CourseImportError("Provide a full local path or download a preset.");
	}

	try {
		const warnings: string[] = [];
		const detected = detectChapters(listFiles(root));
		if (detected.length === 0) throw new CourseImportError("No numbered chapter folders with a Readme.md were found.");
		const ids = assignChapterIds(detected);
		const courseId = existing?.id ?? preset?.id ?? localCourseId(path.basename(root), createHash("sha256").update(root).digest("hex").slice(0, 8));
		if (!isSafeId(courseId)) throw new CourseImportError("Could not name this course.");
		const previous = existing ?? index.courses.find((course) => course.id === courseId);
		const oldById = new Map((previous?.chapters ?? []).map((chapter) => [chapter.id, chapter]));
		const extractGraph = request.extractGraph ?? previous?.extractGraph ?? false;
		const importNotes = deps.importNotes ?? ((input) => extraction.importNotes(input));
		const registerImport = deps.registerImport ?? ((filePath: string) => sourceDirectory.registerImport(filePath));
		let copied = 0;
		let unchanged = 0;
		let extracted = 0;
		const chapters: ChapterRecord[] = [];
		const seen = new Set<string>();

		for (let i = 0; i < detected.length; i += 1) {
			const spec = detected[i]!;
			const id = ids[i]!;
			seen.add(id);
			const old = oldById.get(id);
			const files = readChapter(root, spec.folderName, spec.readmePath, warnings);
			if (!files) {
				if (old) chapters.push(old);
				continue;
			}
			const contentHash = hashChapter(files.readmeRel, files.readme, files.images);
			const text = files.readme.toString("utf8");
			const dir = chapterDirectory(courseId, id);
			const changed = !old || old.contentHash !== contentHash;
			if (changed) {
				writeChapter(dir, files);
				copied += 1;
			} else {
				unchanged += 1;
			}
			const chapter: ChapterRecord = {
				id,
				order: spec.order,
				folderName: spec.folderName,
				title: chapterTitle(text, spec.folderName),
				present: true,
				contentHash,
				readmeRel: files.readmeRel,
				imageCount: files.images.length,
				updatedAt: changed ? now.toISOString() : (old?.updatedAt ?? now.toISOString()),
				extractedHash: old?.extractedHash ?? null,
				graphError: old?.graphError ?? null,
				teachChatIds: old?.teachChatIds ?? [],
				practiceChatIds: old?.practiceChatIds ?? [],
				card: old?.card ?? null,
				concepts: mergeConcepts(old?.concepts ?? [], conceptHeadings(text)),
			};
			const needsGraph = extractGraph && chapter.extractedHash !== contentHash;
			if (needsGraph) {
				const logical = chapterSourcePath(courseId, id);
				try {
					registerImport(logical);
					await importNotes({ filePath: logical, text });
					chapter.extractedHash = contentHash;
					chapter.graphError = null;
					extracted += 1;
				} catch (error) {
					chapter.graphError = error instanceof Error ? error.message : String(error);
				}
			}
			chapters.push(chapter);
		}
		for (const old of previous?.chapters ?? []) {
			if (!seen.has(old.id)) chapters.push({ ...old, present: false });
		}
		chapters.sort((a, b) => a.order - b.order || a.folderName.localeCompare(b.folderName));
		const record: CourseRecord = {
			id: courseId,
			title: preset?.title ?? previous?.title ?? path.basename(origin.kind === "local" ? origin.path : root),
			presetId: preset?.id ?? previous?.presetId ?? null,
			origin,
			createdAt: previous?.createdAt ?? now.toISOString(),
			updatedAt: now.toISOString(),
			extractGraph,
			chapters,
		};
		const courses = index.courses.filter((course) => course.id !== courseId);
		courses.push(record);
		courseStore.write({ version: 1, courses });
		return { pack: coursePackSnapshot(now), courseId, copied, unchanged, extracted, warnings };
	} finally {
		if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
	}
}

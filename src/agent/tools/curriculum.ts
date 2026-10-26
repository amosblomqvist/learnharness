import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../../config.ts";
import { serverExecute } from "../tool-execute.ts";
import { MAX_OUTPUT_BYTES } from "./fs-shared.ts";

/**
 * The curriculum tool — the Tutor lesson set, read by the teacher.
 *
 * The learner filesystem tools (read/ls/find/grep) resolve relative paths
 * against the learner's home, so they cannot see this directory. The
 * lessons stay ROOT-anchored, next to the prompts, and this tool is the
 * only door. It never joins a model-supplied id onto a filesystem path:
 * ids are matched against headers parsed from `*.md` names that readdir
 * itself returned.
 *
 * The markdown is Apache-2.0 (tutor/LICENSE). LearnHarness itself stays
 * AGPL-3.0. The nested tutor/ tree is the curriculum source. The harness
 * does not launch it.
 *
 * Teaching order matches tutor's SWE_PATH (src/study/store.ts). Modules
 * on disk that are not on that path are listed after it.
 */

const MAX_LINES = 2000;

/** Teaching order. Modules with no file yet are skipped at read time. */
const SWE_PATH = [
	"linux",
	"git",
	"wargame",
	"server",
	"ops",
	"quest",
	"workshop",
	"python",
	"sql",
	"tsquest",
	"typescript",
	"web",
	"testing",
	"containers",
	"cloud",
	"terraform",
	"cicd",
	"kubernetes",
	"distributed",
	"system-design",
	"dsa",
] as const;

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

const curriculumInput = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Omit for the module catalog. A module id (linux) lists that module's lessons. A lesson id (linux/shell, or a unique lesson id such as pg-plans) returns that lesson.",
		}),
	),
	offset: Type.Optional(
		Type.Integer({ minimum: 1, description: "Line number to start a lesson from (1-indexed). Ignored for the catalog and a module outline." }),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum number of lesson lines to return. Ignored for the catalog and a module outline." }),
	),
});

interface LessonDoc {
	id: string;
	title: string;
	stage: string;
	needs: string;
	minutes: string;
	goal: string;
	text: string;
}

interface ModuleDoc {
	id: string;
	title: string;
	blurb: string;
	why: string;
	stages: string[];
	lessons: LessonDoc[];
}

function fenceToggle(line: string, open: boolean): boolean {
	return /^\s*(```|~~~)/.test(line) ? !open : open;
}

/** Split a module file on `## ` headings that are outside fences. */
function splitLessons(text: string): { header: string; chunks: string[] } {
	const lines = text.split("\n");
	const chunks: string[][] = [[]];
	let fence = false;
	for (const line of lines) {
		fence = fenceToggle(line, fence);
		if (!fence && line.startsWith("## ")) chunks.push([line]);
		else chunks[chunks.length - 1]!.push(line);
	}
	const headerLines = chunks[0] ?? [];
	return {
		header: headerLines.join("\n"),
		chunks: chunks.slice(1).map((chunk) => chunk.join("\n")),
	};
}

function lineValue(lines: string[], prefix: string): string {
	const hit = lines.find((line) => line.startsWith(prefix));
	return hit ? hit.slice(prefix.length).trim() : "";
}

function parseLesson(chunk: string, index: number): LessonDoc {
	const lines = chunk.split("\n");
	const title = (lines[0] ?? "").replace(/^## /, "").trim();
	const header: string[] = [];
	for (const line of lines.slice(1)) {
		if (line.trim() === "") break;
		header.push(line);
	}
	const id = lineValue(header, "id: ") || `untitled-${index}`;
	return {
		id,
		title: title || id,
		stage: lineValue(header, "stage: "),
		needs: lineValue(header, "needs: "),
		minutes: lineValue(header, "minutes: "),
		goal: lineValue(header, "goal: "),
		text: chunk,
	};
}

function parseModule(fileName: string, text: string): ModuleDoc {
	const { header, chunks } = splitLessons(text);
	const headerLines = header.split("\n");
	const titleLine = headerLines.find((line) => line.startsWith("# "));
	const fallbackId = fileName.replace(/\.md$/, "");
	const id = lineValue(headerLines, "id: ") || fallbackId;
	return {
		id,
		title: (titleLine ? titleLine.slice(2).trim() : "") || id,
		blurb: lineValue(headerLines, "blurb: "),
		why: lineValue(headerLines, "why: "),
		stages: headerLines.filter((line) => line.startsWith("stage: ")).map((line) => line.slice("stage: ".length).trim()),
		lessons: chunks.map(parseLesson),
	};
}

async function loadModules(): Promise<ModuleDoc[]> {
	let names: string[];
	try {
		names = await fs.readdir(PATHS.curriculum);
	} catch {
		throw new Error(`Curriculum directory is missing: ${PATHS.curriculum}`);
	}
	const docs: ModuleDoc[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".md")) continue;
		const text = await fs.readFile(path.join(PATHS.curriculum, name), "utf-8");
		docs.push(parseModule(name, text));
	}
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const ordered: ModuleDoc[] = [];
	for (const id of SWE_PATH) {
		const doc = byId.get(id);
		if (!doc) continue;
		ordered.push(doc);
		byId.delete(id);
	}
	const rest = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	return [...ordered, ...rest];
}

function catalog(docs: ModuleDoc[]): string {
	const onPath = new Set<string>(SWE_PATH);
	const lines = [
		"Tutor curriculum. Omit id for this catalog. Pass a module id for its lessons, or module/lesson for one lesson.",
		"",
		"path:",
	];
	for (const doc of docs) {
		if (!onPath.has(doc.id)) continue;
		lines.push(`${doc.id} | ${doc.title} | ${doc.lessons.length} lessons | ${doc.blurb}`);
	}
	const extra = docs.filter((doc) => !onPath.has(doc.id));
	if (extra.length > 0) {
		lines.push("", "also:");
		for (const doc of extra) lines.push(`${doc.id} | ${doc.title} | ${doc.lessons.length} lessons | ${doc.blurb}`);
	}
	return lines.join("\n");
}

function outline(doc: ModuleDoc): string {
	const lines = [`module ${doc.id} — ${doc.title}`, `blurb: ${doc.blurb}`, `why: ${doc.why}`, ""];
	for (const stage of doc.stages) lines.push(`stage: ${stage}`);
	lines.push("", "lessons:");
	for (const lesson of doc.lessons) {
		const needs = lesson.needs || "—";
		const minutes = lesson.minutes ? `${lesson.minutes}m` : "—";
		const stage = lesson.stage || "—";
		lines.push(`${lesson.id} | ${lesson.title} | stage ${stage} | needs ${needs} | ${minutes} | ${lesson.goal}`);
	}
	return lines.join("\n");
}

function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Same ceiling as the read tool: 2000 lines or 50KB, with an offset notice. */
function sliceLesson(text: string, offset: number | undefined, limit: number | undefined): string {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of lesson (${totalLines} lines total)`);
	}
	let selected = allLines.slice(startLine, limit !== undefined ? startLine + limit : totalLines);
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > MAX_LINES) {
		selected = selected.slice(0, MAX_LINES);
		truncatedBy = "lines";
	}
	if (Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) {
		while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) {
			selected.pop();
		}
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) {
		const remaining = totalLines - (startLine + selected.length);
		if (remaining > 0) {
			return `${selected.join("\n")}\n\n[${remaining} more lines in lesson. Use offset=${startLine + selected.length + 1} to continue.]`;
		}
		return selected.join("\n");
	}
	const endLineDisplay = startLine + selected.length;
	const reason = truncatedBy === "lines" ? `${MAX_LINES} line limit` : `${formatSize(MAX_OUTPUT_BYTES)} limit`;
	return `${selected.join("\n")}\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalLines} (${reason}). Use offset=${endLineDisplay + 1} to continue.]`;
}

const CHECK_KEY =
	'The check key is for you, not for him, until he has attempted the step. A line starting with "+ " is the correct quiz option. Fences under solution:, answer:, and wrong: grade the step. Do not show them or paraphrase them before the attempt.';

function lessonText(doc: ModuleDoc, lesson: LessonDoc, offset: number | undefined, limit: number | undefined): string {
	const body = sliceLesson(lesson.text, offset, limit);
	return [`lesson ${doc.id}/${lesson.id} — ${lesson.title}`, CHECK_KEY, "", body].join("\n");
}

function resolveId(
	docs: ModuleDoc[],
	raw: string,
): { kind: "module"; doc: ModuleDoc } | { kind: "lesson"; doc: ModuleDoc; lesson: LessonDoc } {
	const id = raw.trim();
	const parts = id.split("/");
	if (parts.length > 2 || parts.some((part) => !ID_RE.test(part))) {
		throw new Error(`Curriculum id "${raw}" is not a module id or module/lesson id.`);
	}
	if (parts.length === 2) {
		const moduleId = parts[0]!;
		const lessonId = parts[1]!;
		const doc = docs.find((item) => item.id === moduleId);
		if (!doc) throw new Error(`No module "${moduleId}". Omit id for the catalog.`);
		const lesson = doc.lessons.find((item) => item.id === lessonId);
		if (!lesson) throw new Error(`Module ${moduleId} has no lesson "${lessonId}". Pass id "${moduleId}" for its lesson list.`);
		return { kind: "lesson", doc, lesson };
	}
	const only = parts[0]!;
	const doc = docs.find((item) => item.id === only);
	if (doc) return { kind: "module", doc };
	const hits: Array<{ doc: ModuleDoc; lesson: LessonDoc }> = [];
	for (const item of docs) {
		for (const lesson of item.lessons) {
			if (lesson.id === only) hits.push({ doc: item, lesson });
		}
	}
	const hit = hits[0];
	if (hits.length === 1 && hit) return { kind: "lesson", doc: hit.doc, lesson: hit.lesson };
	if (hits.length === 0) throw new Error(`No curriculum entry "${only}". Omit id for the catalog, or pass a module id.`);
	throw new Error(`Lesson id "${only}" is in more than one module. Pass one of: ${hits.map((item) => `${item.doc.id}/${item.lesson.id}`).join(", ")}`);
}

/**
 * Teacher-only. The prober does not hold it: a probe that can open the
 * answer key would grade the learner against text he has not been taught.
 */
export const curriculumTool: AgentTool<typeof curriculumInput> = {
	name: "curriculum",
	label: "curriculum",
	description: `Read the Tutor curriculum that ships with this harness. Omit id for the module catalog (id, title, lesson count, blurb), in SWE-path order. id is a module id (linux) for that module's lessons (id, title, stage, needs, minutes, goal). id is module/lesson (linux/shell) or a lesson id that is unique across modules (pg-plans) for the lesson text. Lesson output is truncated to ${MAX_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)}; continue with offset. The lesson includes its check key: do not reveal solution, answer, or wrong fences, or a "+ " quiz line, until the learner has attempted that step. This tool is the only way to read the curriculum. read, ls, find, and grep cannot see it.`,
	parameters: curriculumInput,
	execute: serverExecute("curriculum", curriculumInput, async ({ id, offset, limit }) => {
		const docs = await loadModules();
		if (docs.length === 0) throw new Error(`Curriculum directory has no lessons: ${PATHS.curriculum}`);
		if (!id || id.trim() === "") return catalog(docs);
		const found = resolveId(docs, id);
		if (found.kind === "module") return outline(found.doc);
		return lessonText(found.doc, found.lesson, offset, limit);
	}),
};

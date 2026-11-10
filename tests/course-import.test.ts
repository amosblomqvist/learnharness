import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-"));
process.env.LH_DATA_DIR = dataRoot;
process.env.LH_AUTH_FILE = path.join(dataRoot, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "course-pack");
const { importCourse } = await import("../src/server/course-import.ts");
const { gradeCourseItem, openChapterSession } = await import("../src/server/courses.ts");
const { githubArchiveUrl } = await import("../src/core/course.ts");
const { POST } = await import("../app/api/courses/route.ts");

function copyFixture(): string {
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-src-"));
	fs.cpSync(fixture, dest, { recursive: true });
	return dest;
}

describe("course importer", () => {
	it("copies synthetic chapters, skips unchanged files, and keeps review history", async () => {
		const source = copyFixture();
		const calls: string[] = [];
		const deps = {
			importNotes: async ({ filePath }: { filePath: string; text: string }) => {
				calls.push(filePath);
				return { nodes: 1 };
			},
			registerImport: () => {},
			now: () => new Date("2026-03-01T00:00:00.000Z"),
		};
		const first = await importCourse({ presetId: "system-design-notes", localPath: source, extractGraph: true }, deps);
		assert.equal(first.copied, 2);
		assert.deepEqual(calls, ["courses/system-design-notes/n-01/Readme.md", "courses/system-design-notes/n-02/Readme.md"]);
		const course = first.pack.courses.find((item) => item.id === "system-design-notes");
		assert.ok(course);
		assert.deepEqual(course.chapters.map((chapter) => chapter.title), ["Boxes", "Lines"]);
		assert.equal(course.chapters[0]?.status, "not_started");
		assert.equal(course.chapters[0]?.imageCount, 1);
		assert.deepEqual(course.chapters[0]?.concepts.map((concept) => concept.title), ["Capacity", "Label"]);
		const copied = fs.readFileSync(course.chapters[0]!.readmeFile, "utf8");
		assert.equal(copied, fs.readFileSync(path.join(fixture, "01. Boxes", "Readme.md"), "utf8"));
		assert.doesNotMatch(copied, /Alex Xu|System Design Interview/);
		assert.ok(course.chapters[0]?.readmeFile.startsWith(dataRoot));
		assert.equal(fs.existsSync(path.join(path.dirname(course.chapters[0]!.readmeFile), "images", "box.svg")), true);

		gradeCourseItem("system-design-notes", "n-01", 4, undefined, new Date("2026-03-01T00:00:00.000Z"));
		calls.length = 0;
		const second = await importCourse({ courseId: "system-design-notes", extractGraph: true }, deps);
		assert.equal(second.copied, 0);
		assert.equal(second.unchanged, 2);
		assert.deepEqual(calls, []);
		const kept = second.pack.courses[0]?.chapters.find((chapter) => chapter.id === "n-01");
		assert.equal(kept?.due, "2026-03-02");
		assert.equal(kept?.status, "learning");

		fs.appendFileSync(path.join(source, "02. Lines", "Readme.md"), "\nA new last line about waiting.\n");
		const third = await importCourse({ courseId: "system-design-notes", extractGraph: true }, deps);
		assert.deepEqual(calls, ["courses/system-design-notes/n-02/Readme.md"]);
		assert.equal(third.pack.courses[0]?.chapters.find((chapter) => chapter.id === "n-01")?.due, "2026-03-02");

		fs.rmSync(path.join(source, "02. Lines"), { recursive: true, force: true });
		const fourth = await importCourse({ courseId: "system-design-notes", extractGraph: false }, deps);
		const removed = fourth.pack.courses[0]?.chapters.find((chapter) => chapter.id === "n-02");
		assert.equal(removed?.present, false);
		assert.equal(fourth.pack.today.some((item) => item.chapterId === "n-02"), false);
		const practice = openChapterSession("system-design-notes", "n-01", "practice");
		assert.match(practice.prompt, /Requirements/);
		assert.match(practice.prompt, /Wrap-up/);
	});

	it("downloads a preset archive through the injected fetcher and skips symlinks", async () => {
		const source = copyFixture();
		fs.symlinkSync("/etc/passwd", path.join(source, "01. Boxes", "images", "evil.svg"));
		const parent = path.dirname(source);
		const archive = path.join(parent, "notes.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", parent, path.basename(source)]);
		let seen = "";
		const outcome = await importCourse(
			{ presetId: "system-design-notes", download: true, extractGraph: false },
			{ fetchArchive: async (url) => { seen = url; return fs.readFileSync(archive); } },
		);
		assert.equal(seen, githubArchiveUrl("liquidslr/system-design-notes", "main"));
		const readme = outcome.pack.courses.find((course) => course.id === "system-design-notes")?.chapters[0]?.readmeFile;
		assert.ok(readme);
		assert.equal(fs.existsSync(path.join(path.dirname(readme), "images", "evil.svg")), false);
		assert.equal(fs.existsSync(path.join(path.dirname(readme), "images", "box.svg")), true);
	});

	it("refuses a relative path and opens teaching and interview practice from the copy", async () => {
		await assert.rejects(() => importCourse({ localPath: "notes" }), /full path/);
		const source = copyFixture();
		const outcome = await importCourse({ localPath: source, extractGraph: false });
		const courseId = outcome.courseId;
		assert.notEqual(courseId, "system-design-notes");
		const teach = openChapterSession(courseId, "n-01", "teach");
		assert.match(teach.prompt, /measure what I already understand/);
		assert.equal(teach.pack.courses.find((course) => course.id === courseId)?.chapters[0]?.status, "learning");
		assert.equal(teach.pack.courses.find((course) => course.id === courseId)?.chapters[0]?.teachSessions, 1);
		const practice = openChapterSession(courseId, "n-01", "practice", "capacity");
		assert.doesNotMatch(practice.prompt, /Requirements/);
		assert.match(practice.prompt, /Capacity/);
		const response = await POST(new Request("http://localhost/api/courses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ courseId, extractGraph: false }),
		}));
		assert.equal(response.status, 200);
		const body = await response.json() as { unchanged: number };
		assert.equal(body.unchanged, 2);
	});
});

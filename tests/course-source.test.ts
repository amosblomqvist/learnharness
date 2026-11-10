import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assignChapterIds,
	chapterOrder,
	chapterTitle,
	conceptHeadings,
	detectChapters,
	githubArchiveUrl,
	mergeConcepts,
	parseCourseIndex,
	practicePrompt,
	teachingPrompt,
} from "../src/core/course.ts";

describe("course source detection", () => {
	it("orders numbered chapter folders and ignores loose files", () => {
		const found = detectChapters([
			"README.md",
			"notes/loose.md",
			"02. Lines/Readme.md",
			"01. Boxes/Readme.md",
			"01. Boxes/images/box.svg",
			"03-no-readme/picture.png",
			"../escape/Readme.md",
		]);
		assert.deepEqual(found.map((chapter) => chapter.folderName), ["01. Boxes", "02. Lines"]);
		assert.deepEqual(assignChapterIds(found), ["n-01", "n-02"]);
		assert.equal(chapterOrder("01. Boxes"), 1);
		assert.equal(chapterOrder("readme"), null);
	});

	it("disambiguates two folders that share a number", () => {
		const ids = assignChapterIds([
			{ order: 1, folderName: "01. Boxes" },
			{ order: 1, folderName: "01. Other" },
		]);
		assert.equal(ids[0], "n-01-01-boxes");
		assert.equal(ids[1], "n-01-01-other");
	});

	it("reads the title and level-two headings, and keeps review cards when a heading returns", () => {
		const markdown = "# Boxes\n\n## Capacity\n\ntext\n\n### ignored\n\n## Label\n";
		assert.equal(chapterTitle(markdown, "01. Boxes"), "Boxes");
		assert.deepEqual(conceptHeadings(markdown).map((heading) => heading.title), ["Capacity", "Label"]);
		const card = { ease: 2.5, intervalDays: 6, repetitions: 2, due: "2026-04-01", lastReviewed: null, lastGrade: 4 };
		const merged = mergeConcepts(
			[{ id: "capacity", title: "Capacity", retired: false, card }, { id: "gone", title: "Gone", retired: false, card: null }],
			conceptHeadings(markdown),
		);
		assert.equal(merged.find((concept) => concept.id === "capacity")?.card?.intervalDays, 6);
		assert.equal(merged.find((concept) => concept.id === "gone")?.retired, true);
		assert.equal(merged.find((concept) => concept.id === "label")?.retired, false);
	});

	it("quotes the chapter file and uses the interview frame only for that preset", () => {
		const teach = teachingPrompt({ title: "Boxes", folderName: "01. Boxes", readmePath: "/tmp/boxes/Readme.md", directory: "/tmp/boxes" });
		assert.match(teach, /`\/tmp\/boxes\/Readme.md`/);
		assert.match(teach, /measure what I already understand/);
		const interview = practicePrompt({ title: "Boxes", folderName: "01. Boxes", readmePath: "/tmp/boxes/Readme.md", directory: "/tmp/boxes", interview: true });
		assert.match(interview, /1\. Requirements/);
		assert.match(interview, /5\. Wrap-up/);
		const generic = practicePrompt({ title: "Boxes", folderName: "01. Boxes", readmePath: "/tmp/boxes/Readme.md", directory: "/tmp/boxes", interview: false, conceptTitle: "Capacity" });
		assert.doesNotMatch(generic, /Requirements/);
		assert.match(generic, /Capacity/);
	});

	it("builds the preset archive URL and refuses a course index that is not version 1", () => {
		assert.equal(githubArchiveUrl("liquidslr/system-design-notes", "main"), "https://codeload.github.com/liquidslr/system-design-notes/tar.gz/refs/heads/main");
		assert.throws(() => githubArchiveUrl("https://evil.example/repo", "main"));
		assert.throws(() => parseCourseIndex({ version: 2, courses: [] }));
		assert.throws(() => parseCourseIndex({
			version: 1,
			courses: [{
				id: "local-boxes-aaaaaaaa",
				title: "Boxes",
				presetId: null,
				origin: { kind: "local", path: "/tmp/boxes" },
				createdAt: "2026-03-01T00:00:00.000Z",
				updatedAt: "2026-03-01T00:00:00.000Z",
				extractGraph: false,
				chapters: [{
					id: "n-01", order: 1, folderName: "01. Boxes", title: "Boxes", present: true, contentHash: "abc",
					readmeRel: "../secret.md", imageCount: 0, updatedAt: "2026-03-01T00:00:00.000Z", extractedHash: null,
					graphError: null, teachChatIds: [], practiceChatIds: [], card: null, concepts: [],
				}],
			}],
		}));
	});
});

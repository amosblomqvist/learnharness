import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newCourseLessonMessage, nativeInputCause, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

const ctx = {
	courseId: "course_1",
	courseTitle: "Calculus",
	courseGoal: "Use derivatives",
	lessonId: "limits",
	lessonTitle: "Limits",
	lessonGoal: "Understand limits",
	buildsOn: [],
	leadsInto: ["Derivatives", "Continuity"],
	guideSummary: "A limit is the value a function approaches.",
};

describe("course-lesson marker", () => {
	it("model face: the approved bracketed preamble, flattened to a user message", () => {
		const marker = newCourseLessonMessage(ctx);
		assert.equal(
			marker.content,
			[
				`[Session context] — this session is one lesson of the learner's course "Calculus" (course goal: Use derivatives).`,
				"Lesson: Limits",
				"Lesson goal: Understand limits",
				"Builds on earlier lessons: none",
				"Leads into: Derivatives; Continuity",
				"Guide material for this lesson (summary of the learner's guide):",
				"A limit is the value a function approaches.",
			].join("\n"),
		);
		const wire = toLlmMessages([marker as unknown as never]);
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.role, "user");
		assert.equal(nativeInputCause(marker as never, []), "neutral");
	});

	it("view face: a data-course-lesson card above the first user message, never a text bubble", () => {
		const marker = { ...newCourseLessonMessage(ctx) } as LhMessage;
		const view = projectView([marker]);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		assert.deepEqual(view[0]!.parts.map((p) => p.type), ["data-course-lesson"]);
		assert.deepEqual((view[0]!.parts[0] as { data: unknown }).data, ctx);
	});
});

describe("general.courseEstimates setting", () => {
	it("defaults to frozen and sanitizes to the two modes", () => {
		assert.equal(FACTORY_SETTINGS.general.courseEstimates, "frozen");
		assert.equal(resolveSettings(null).general.courseEstimates, "frozen");
		assert.equal(sanitizeUserSettings({ version: 1, general: { courseEstimates: "live" } })!.general!.courseEstimates, "live");
		assert.equal(sanitizeUserSettings({ version: 1, general: { courseEstimates: "weekly" } })!.general!.courseEstimates, undefined);
	});

	it("the section PUT body validates it", () => {
		assert.deepEqual(parseGeneralSettingsBody({ courseEstimates: "live" }), { ok: true, settings: { courseEstimates: "live" } });
		assert.equal(parseGeneralSettingsBody({ courseEstimates: "nope" }).ok, false);
	});
});

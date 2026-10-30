import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { coursePlannerPrompt, planCourse, plannedCourseProblems, type PlannedCourse } from "../src/agent/subagents/course-planner.ts";
import { computePace } from "../src/core/pace.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { lesson } from "./helpers/course-fixtures.ts";

const window = { today: "2026-10-30", deadline: "2026-11-30" };
const pace = computePace([], new Date(Date.UTC(2026, 9, 30)));

function planned(lessons: PlannedCourse["lessons"]): PlannedCourse {
	return { title: "T", goal: "G", feasibility: "Fits.", lessons };
}
const plain = (id: string, extra: Partial<PlannedCourse["lessons"][number]> = {}) => {
	const { sessionIds: _s, ...rest } = lesson({ id, ...extra });
	return rest;
};

describe("course planner — submit-seam validation", () => {
	it("accepts a valid generate submission", () => {
		assert.equal(plannedCourseProblems(planned([plain("a"), plain("b", { prerequisites: ["a"], targetDate: "2026-11-12" })]), { mode: "generate", ...window }), null);
	});

	it("rejects dates outside today…deadline and before a prerequisite", () => {
		const p = plannedCourseProblems(
			planned([plain("a", { targetDate: "2026-12-01" }), plain("b", { prerequisites: ["c"], targetDate: "2026-11-01" }), plain("c", { targetDate: "2026-11-05" })]),
			{ mode: "generate", ...window },
		)!;
		assert.match(p, /"a" targetDate 2026-12-01 is outside/);
		assert.match(p, /"b" \(2026-11-01\) is scheduled before its prerequisite "c"/);
	});

	it("requires a reason for a multiplier other than 1", () => {
		assert.match(plannedCourseProblems(planned([plain("a", { multiplier: 1.5 })]), { mode: "generate", ...window })!, /multiplierReason/);
		assert.equal(plannedCourseProblems(planned([plain("a", { multiplier: 1.5, multiplierReason: "proofs" })]), { mode: "generate", ...window }), null);
	});

	it("replan-dates: only dates/estimates may change, and the lesson set is fixed", () => {
		const previous = { ...planned([]), lessons: [lesson({ id: "a" }), lesson({ id: "b" })] };
		const input = { mode: "replan-dates" as const, ...window, previous };
		assert.equal(plannedCourseProblems(planned([plain("a", { targetDate: "2026-11-20" }), plain("b", { predictedNodes: 5 })]), input), null);
		assert.match(plannedCourseProblems(planned([plain("a", { title: "renamed" }), plain("b")]), input)!, /keep title, goal/);
		assert.match(plannedCourseProblems(planned([plain("a")]), input)!, /may only reschedule/);
	});

	it("replan-restructure: lessons with sessions may not be dropped; done lessons are never resubmitted", () => {
		const previous = { ...planned([]), lessons: [lesson({ id: "a", sessionIds: ["s1"] }), lesson({ id: "b" })] };
		const doneLessons = [lesson({ id: "d" })];
		const input = { mode: "replan-restructure" as const, ...window, previous, doneLessons };
		assert.equal(plannedCourseProblems(planned([plain("a", { prerequisites: ["d"] }), plain("new")]), input), null, "b dropped, prereq on a done lesson is fine");
		assert.match(plannedCourseProblems(planned([plain("b")]), input)!, /"a" already has teaching sessions/);
		assert.match(plannedCourseProblems(planned([plain("a"), plain("d")]), input)!, /already done/);
	});

	it("the prompt carries the facts, the pace digest, feedback and the guide", () => {
		const prompt = coursePlannerPrompt({ mode: "generate", guideText: "# Guide", goalInput: "", availabilityNotes: "", ...window, pace, feedback: "fewer lessons" });
		assert.match(prompt, /Learner's goal: \(none given — infer it from the guide\)/);
		assert.match(prompt, /~8 min\/node · ~10 min probing \(default pace/);
		assert.match(prompt, /Learner's feedback: fewer lessons/);
		assert.match(prompt, /<guide>\n# Guide\n<\/guide>$/);
	});
});

describe("course planner — the agent loop", () => {
	it("an invalid submission error-backs and the retry is accepted; usage reaches onStep", async () => {
		const faux = createFauxCore({});
		let sawError = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_course", planned([plain("a", { targetDate: "2027-01-01" })]) as never)], { stopReason: "toolUse" }),
			(context) => {
				const last = context.messages.at(-1) as { role: string; content: Array<{ text?: string }> };
				sawError = last.content.map((c) => c.text ?? "").join("");
				return fauxAssistantMessage([fauxToolCall("submit_course", planned([plain("a")]) as never)], { stopReason: "toolUse" });
			},
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple } as unknown as PiEngine;
		let steps = 0;
		const result = await planCourse({
			mode: "generate", guideText: "# Guide", goalInput: "", availabilityNotes: "", ...window, pace, engine,
			onStep: () => steps++,
		});
		assert.match(sawError, /outside 2026-10-30 … 2026-11-30/);
		assert.deepEqual(result.lessons.map((l) => l.id), ["a"]);
		assert.equal(result.lessons[0]!.multiplier, 1);
		assert.equal(steps, 2);
	});
});

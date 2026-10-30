/**
 * THE COURSE PLANNER (courses plan, owner-approved 2026-10-30): a guide
 * markdown + optional goal + deadline + availability notes become a
 * dependency graph of lessons with target dates, predicted plan nodes,
 * an optional pace multiplier, and a feasibility note.
 *
 * One runSubmitAgent call (role coursePlanner → the STRONG slot). When the
 * composition root passes the graph context (the same graphToolsEnabled
 * gate the prober uses), the prober's names-only map tools ride along as
 * extraTools so the planner can see what the learner was already taught.
 * Semantic validation at the submit seam (graph, dates, estimates, replan
 * invariants) error-backs into a retry within the turn budget.
 *
 * Minutes are NEVER the model's output: it predicts nodes, code multiplies
 * by the learner's measured pace (core/pace.ts).
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { proberGraphTools, type GraphToolContext } from "../tools/graph.ts";
import type { CourseLesson, PaceStats } from "../../core/contracts.ts";
import { lessonGraphProblems } from "../../core/course-graph.ts";
import { isIsoDate } from "../../core/course-progress.ts";
import { paceLine } from "../../core/pace.ts";

export const COURSE_PLANNER_INSTRUCTIONS = `You design a course for one learner: a dependency graph of lessons that takes them from where they are to their goal by a deadline, using the guide they provided as the source material.

Each lesson is one teaching session: a focused goal that an adaptive tutor will probe, plan and teach in roughly 2–6 plan steps. Prefer more, smaller lessons over sprawling ones.

If the learner gave a goal, emphasize what serves it and leave out guide material that does not. If not, infer the goal from the guide (usually: understand the guide's content well enough to use it) and state it.

Prerequisites are lessons whose understanding this lesson builds on — only real dependencies, not mere order.

For each lesson write \`guideSummary\`: a faithful condensation of the guide material it covers, keeping definitions, formulas and claims the guide states. Do not add content the guide does not contain.

Estimate \`predictedNodes\`: how many plan steps the tutor will need. Minutes are computed from the learner's measured pace; set \`multiplier\` (0.5–2) only when the material is clearly faster or slower than average for this learner, with a one-line reason.

If you have knowledge-map tools, check what the learner has already been taught; shrink or drop lessons they've covered and say so in the feasibility note.

Schedule target dates between today and the deadline, respecting prerequisites and the learner's availability notes (or, without notes, their historical weekly study time). Write a short \`feasibility\` note: whether it fits, the weekly time it needs vs. their history, and what to cut if it doesn't.

Submit with \`submit_course\`.`;

export type PlannerMode = "generate" | "replan-dates" | "replan-restructure";

/** A lesson as the planner returns it (sessions are linked by code, not the model). */
export type PlannedLesson = Omit<CourseLesson, "sessionIds">;

export interface PlannedCourse {
	title: string;
	goal: string;
	lessons: PlannedLesson[];
	feasibility: string;
}

export interface PlanCourseInput {
	mode: PlannerMode;
	guideText: string;
	goalInput: string;
	deadline: string;
	availabilityNotes: string;
	/** YYYY-MM-DD, learner-local. */
	today: string;
	pace: PaceStats;
	feedback?: string;
	/** Regenerate: the previous draft. Replan: the course's current
	 *  not-done lessons (and its title/goal/feasibility). */
	previous?: PlannedCourse & { lessons: CourseLesson[] };
	/** Replan: lessons already done — fixed, never resubmitted. */
	doneLessons?: CourseLesson[];
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	/** Present = the graph-tools gate is open. */
	graph?: GraphToolContext;
	onStep: (usage: Usage, model: string) => void;
}

const lessonSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable slug, e.g. 'derivatives-intuition'" }),
	title: Type.String({ minLength: 1 }),
	goal: Type.String({ minLength: 1, description: "What the learner should understand or be able to do after this lesson" }),
	// May be empty: a hand-added lesson has no guide summary, and a
	// dates-only replan must echo it verbatim.
	guideSummary: Type.String({ description: "Faithful condensation of the guide material this lesson covers" }),
	prerequisites: Type.Array(Type.String(), { description: "Ids of lessons this one builds on (may include already-done lessons)" }),
	targetDate: Type.String({ description: "YYYY-MM-DD, between today and the deadline" }),
	predictedNodes: Type.Integer({ minimum: 1, description: "Plan steps the tutor will need" }),
	multiplier: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2, description: "Adjustment to the pace baseline; omit or 1 for none" })),
	multiplierReason: Type.Optional(Type.String({ description: "One line — required when multiplier is not 1" })),
});

const courseSchema = Type.Object({
	title: Type.String({ minLength: 1, description: "Short course title" }),
	goal: Type.String({ minLength: 1, description: "The course goal (the learner's, or the one you inferred)" }),
	lessons: Type.Array(lessonSchema, { minItems: 1 }),
	feasibility: Type.String({ minLength: 1 }),
});

function fillCourse(input: any): PlannedCourse {
	return {
		title: String(input.title).trim(),
		goal: String(input.goal).trim(),
		feasibility: String(input.feasibility).trim(),
		lessons: (input.lessons as any[]).map((l) => ({
			id: String(l.id).trim(),
			title: String(l.title).trim(),
			goal: String(l.goal).trim(),
			guideSummary: String(l.guideSummary).trim(),
			prerequisites: [...new Set((l.prerequisites as unknown[]).map((p) => String(p).trim()))],
			targetDate: String(l.targetDate).trim(),
			predictedNodes: l.predictedNodes,
			multiplier: typeof l.multiplier === "number" ? l.multiplier : 1,
			...(typeof l.multiplierReason === "string" && l.multiplierReason.trim() ? { multiplierReason: l.multiplierReason.trim() } : {}),
		})),
	};
}

/** Every submit-seam problem for the planned course; null = accept. */
export function plannedCourseProblems(value: PlannedCourse, input: Pick<PlanCourseInput, "mode" | "today" | "deadline" | "previous" | "doneLessons">): string | null {
	const problems: string[] = [];
	const done = input.doneLessons ?? [];
	const doneIds = new Set(done.map((l) => l.id));
	for (const l of value.lessons) {
		if (doneIds.has(l.id)) problems.push(`Lesson "${l.id}" is already done — do not resubmit done lessons.`);
	}
	problems.push(...lessonGraphProblems([...done, ...value.lessons.map((l) => ({ ...l, sessionIds: [] }))]));

	const byId = new Map(value.lessons.map((l) => [l.id, l]));
	for (const l of value.lessons) {
		if (!isIsoDate(l.targetDate)) problems.push(`Lesson "${l.id}" targetDate "${l.targetDate}" is not a YYYY-MM-DD date.`);
		else if (l.targetDate < input.today || l.targetDate > input.deadline) {
			problems.push(`Lesson "${l.id}" targetDate ${l.targetDate} is outside ${input.today} … ${input.deadline}.`);
		}
		for (const p of l.prerequisites) {
			const pre = byId.get(p);
			if (pre && isIsoDate(pre.targetDate) && isIsoDate(l.targetDate) && pre.targetDate > l.targetDate) {
				problems.push(`Lesson "${l.id}" (${l.targetDate}) is scheduled before its prerequisite "${p}" (${pre.targetDate}).`);
			}
		}
		if (!Number.isInteger(l.predictedNodes) || l.predictedNodes < 1) problems.push(`Lesson "${l.id}" predictedNodes must be an integer ≥ 1.`);
		if (l.multiplier < 0.5 || l.multiplier > 2) problems.push(`Lesson "${l.id}" multiplier must be within 0.5–2.`);
		if (l.multiplier !== 1 && !l.multiplierReason) problems.push(`Lesson "${l.id}" sets multiplier ${l.multiplier} — give a one-line multiplierReason.`);
	}

	const previous = input.previous?.lessons ?? [];
	if (input.mode === "replan-dates") {
		const prevById = new Map(previous.map((l) => [l.id, l]));
		if (value.lessons.length !== previous.length || value.lessons.some((l) => !prevById.has(l.id))) {
			problems.push(`Without feedback this replan may only reschedule: submit exactly the lessons ${previous.map((l) => `"${l.id}"`).join(", ")}.`);
		} else {
			for (const l of value.lessons) {
				const p = prevById.get(l.id)!;
				const same =
					p.title === l.title &&
					p.goal === l.goal &&
					p.guideSummary === l.guideSummary &&
					[...p.prerequisites].sort().join("\n") === [...l.prerequisites].sort().join("\n");
				if (!same) problems.push(`Lesson "${l.id}": keep title, goal, guideSummary and prerequisites exactly as given — only targetDate, predictedNodes and multiplier may change.`);
			}
		}
	}
	if (input.mode === "replan-restructure") {
		for (const p of previous) {
			if (p.sessionIds.length > 0 && !byId.has(p.id)) {
				problems.push(`Lesson "${p.id}" already has teaching sessions — keep it (you may edit it, but not drop it).`);
			}
		}
	}
	return problems.length > 0 ? problems.join("\n") : null;
}

function lessonsJson(lessons: readonly (PlannedLesson | CourseLesson)[]): string {
	return JSON.stringify(
		lessons.map(({ id, title, goal, guideSummary, prerequisites, targetDate, predictedNodes, multiplier, multiplierReason }) => ({
			id, title, goal, guideSummary, prerequisites, targetDate, predictedNodes, multiplier,
			...(multiplierReason ? { multiplierReason } : {}),
		})),
		null,
		1,
	);
}

/** The user prompt: facts first, the guide last. */
export function coursePlannerPrompt(input: Omit<PlanCourseInput, "engine" | "signal" | "graph" | "onStep">): string {
	const pace = input.pace;
	const lines = [
		`Today: ${input.today}`,
		`Deadline: ${input.deadline}`,
		`Learner's goal: ${input.goalInput.trim() || "(none given — infer it from the guide)"}`,
		`Availability notes: ${input.availabilityNotes.trim() || "(none given)"}`,
		"",
		`Learner's measured pace: ${paceLine(pace)}.`,
		`Historical study time: ~${pace.weeklyMinutes} active min/week over ~${pace.studyDaysPerWeek} study days/week (last 4 weeks).`,
		`Baseline lesson minutes = ${pace.overheadMinutes} (probing) + predictedNodes × ${pace.nodeMinutes}; you predict nodes and may apply a multiplier.`,
	];
	if (input.mode === "generate" && input.previous) {
		lines.push("", "Your previous draft (the learner asked for a new version):", lessonsJson(input.previous.lessons));
	}
	if (input.mode !== "generate") {
		lines.push("", `This is a REPLAN of the existing course "${input.previous?.title ?? ""}" (goal: ${input.previous?.goal ?? ""}).`);
		if ((input.doneLessons ?? []).length > 0) {
			lines.push("Lessons already done (fixed — do not resubmit; later lessons may still list them as prerequisites):", lessonsJson(input.doneLessons!));
		}
		lines.push("Remaining lessons to schedule:", lessonsJson(input.previous?.lessons ?? []));
		lines.push(
			input.mode === "replan-dates"
				? "Reschedule only: keep every remaining lesson's id, title, goal, guideSummary and prerequisites exactly; change only targetDate, predictedNodes and multiplier."
				: "You may restructure the remaining lessons as the feedback asks: drop, merge, split, add or edit them. Keep the id of any lesson you keep.",
		);
		lines.push("Submit your title and goal unchanged from the course's.");
	}
	if (input.feedback?.trim()) lines.push("", `Learner's feedback: ${input.feedback.trim()}`);
	lines.push("", "The learner's guide:", "<guide>", input.guideText, "</guide>");
	return lines.join("\n");
}

export async function planCourse(input: PlanCourseInput): Promise<PlannedCourse> {
	return withBgLlmSlot(input.signal, () =>
		runSubmitAgent<PlannedCourse>({
			role: "coursePlanner",
			toolName: "submit_course",
			toolDescription: "Submit the course: title, goal, lessons and feasibility note.",
			parameters: courseSchema,
			fill: fillCourse,
			validate: (value) => plannedCourseProblems(value, input),
			systemPrompt: COURSE_PLANNER_INSTRUCTIONS,
			prompt: coursePlannerPrompt(input),
			engine: input.engine,
			signal: input.signal,
			onStep: (usage, model) => input.onStep(usage, model),
			neverSubmitted: "the course planner never submitted a course",
			...(input.graph ? { extraTools: proberGraphTools(input.graph) } : {}),
			maxTurns: 16,
		}),
	);
}

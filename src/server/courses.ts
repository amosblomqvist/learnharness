/**
 * Courses — the server seam behind app/api/courses/** (courses plan,
 * owner-approved 2026-10-30). Routes stay transport; every rule lives here
 * or in core (course-graph / course-progress / pace).
 *
 * Writers: the course store (sole writer of data/courses/) and, for a
 * lesson start, the chat store (createChat + the course-lesson marker).
 * Progress and minutes are DERIVED at read time — never stored.
 */

import { localDate, isIsoDate, lessonOverdue, lessonStatus, courseHealth, sessionDone } from "../core/course-progress.ts";
import { lessonGraphProblems, lessonSlug, topoOrder, wouldCycle, dependentsOf } from "../core/course-graph.ts";
import { computePace, lessonMinutes } from "../core/pace.ts";
import { newCourseLessonMessage } from "../core/native-messages.ts";
import { resolveRoleSpec, graphToolsEnabled } from "../core/settings-resolution.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import type {
	ChatRecord,
	CourseEstimateMode,
	CourseLesson,
	CourseListItem,
	CourseRecord,
	CourseView,
	LessonView,
	PaceStats,
	PlannerRunUsage,
} from "../core/contracts.ts";
import { planCourse, type PlannedCourse, type PlannerMode } from "../agent/subagents/course-planner.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { stores, effectiveSettings } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { turnCost } from "./pricing.ts";
import { stampNewSessionModel, titleFromPrompt } from "./chats.ts";

/** Guide size cap (owner-approved default): 400 KB of text. */
export const GUIDE_MAX_BYTES = 400 * 1024;
export const GUIDE_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
const MAX_PREDICTED_NODES = 50;

/** A refusal with its HTTP status — routes map it 1:1. */
export class CourseError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly courseId?: string,
	) {
		super(message);
		this.name = "CourseError";
	}
}

// ─── reads ───────────────────────────────────────────────────────────────────

function allChatRecords(): ChatRecord[] {
	return stores.chatStore
		.listChats()
		.map((c) => stores.chatStore.getChat(c.id))
		.filter((c): c is ChatRecord => c !== null);
}

/** The learner's current pace over every session on disk. */
export function learnerPace(now: Date = new Date()): PaceStats {
	return computePace(allChatRecords(), now);
}

export function courseEstimateMode(): CourseEstimateMode {
	return effectiveSettings().general.courseEstimates;
}

function linkedChats(lessons: readonly CourseLesson[]): Map<string, ChatRecord> {
	const out = new Map<string, ChatRecord>();
	for (const id of new Set(lessons.flatMap((l) => l.sessionIds))) {
		const chat = stores.chatStore.getChat(id);
		if (chat) out.set(id, chat);
	}
	return out;
}

function lessonViews(lessons: readonly CourseLesson[], chats: ReadonlyMap<string, ChatRecord>, pace: PaceStats, today: string): LessonView[] {
	return topoOrder(lessons).map((lesson) => {
		const status = lessonStatus(lesson, chats);
		return {
			...lesson,
			status,
			overdue: lessonOverdue(lesson, status, today),
			estimate: lessonMinutes(lesson, pace),
			sessions: lesson.sessionIds
				.map((id) => chats.get(id))
				.filter((c) => c !== undefined)
				.map((c) => ({ id: c.id, title: c.title, done: sessionDone(c) })),
		};
	});
}

function courseCost(usage: readonly PlannerRunUsage[]): CourseView["cost"] {
	let dollars = 0;
	let unpriced = 0;
	for (const run of usage) {
		const cost = turnCost({ id: run.at, messageId: "", at: run.at, model: run.model, steps: run.steps });
		if (cost === null) unpriced++;
		else dollars += cost;
	}
	return { dollars, unpriced, runs: usage.length };
}

export function courseView(record: CourseRecord, now: Date = new Date()): CourseView {
	const today = localDate(now);
	const mode = courseEstimateMode();
	const pace = mode === "live" ? learnerPace(now) : record.pace;
	const chats = linkedChats([...record.lessons, ...(record.pendingReplan?.lessons ?? [])]);
	const lessons = lessonViews(record.lessons, chats, pace, today);
	const { guide, usage, pendingReplan, version: _version, pace: _snapshot, ...rest } = record;
	return {
		...rest,
		guide: { ...(guide.fileName ? { fileName: guide.fileName } : {}), chars: guide.text.length },
		lessons,
		health: record.status === "active" ? courseHealth(lessons.map((l) => l.overdue)) : "on-track",
		doneCount: lessons.filter((l) => l.status === "done").length,
		pace,
		estimateMode: mode,
		...(pendingReplan
			? {
					pendingReplan: {
						...pendingReplan,
						lessons: lessonViews(pendingReplan.lessons, chats, mode === "live" ? pace : pendingReplan.pace, today),
					},
				}
			: {}),
		cost: courseCost(usage),
	};
}

export function listCourseItems(now: Date = new Date()): CourseListItem[] {
	const today = localDate(now);
	return stores.courseStore.listCourses().map((c) => {
		const chats = linkedChats(c.lessons);
		const statuses = c.lessons.map((l) => lessonStatus(l, chats));
		return {
			id: c.id,
			title: c.title,
			status: c.status,
			updatedAt: c.updatedAt,
			doneCount: statuses.filter((s) => s === "done").length,
			lessonCount: c.lessons.length,
			health: c.status === "active" ? courseHealth(c.lessons.map((l, i) => lessonOverdue(l, statuses[i]!, today))) : "on-track",
		};
	});
}

export function getCourseOr404(id: string): CourseRecord {
	const record = /^[A-Za-z0-9_-]+$/.test(id) ? stores.courseStore.getCourse(id) : null;
	if (!record) throw new CourseError("Course not found", 404);
	return record;
}

// ─── planner runs ────────────────────────────────────────────────────────────

/** The planner's engine — refuses honestly (typed throws) before any record is touched. */
function plannerEngine(): PiEngine {
	const spec = resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
	if (!spec) throw new ModelsNotConfiguredError(["strong"]);
	const engine = piEngineForSpec(spec);
	if (!providerKeyPresent(engine.model.provider)) throw new ProviderKeyMissingError(engine.model.provider, ["strong"]);
	return engine;
}

/** The engine seam — tests swap `resolveEngine` for a faux engine (the
 *  extraction.importNotes precedent); production keeps plannerEngine. */
export const coursePlanner = { resolveEngine: plannerEngine };

interface RunOutcome {
	planned?: PlannedCourse;
	error?: unknown;
}

/** One planner run; usage lands on the course record whether it succeeds or not. */
async function runPlanner(
	courseId: string,
	kind: PlannerRunUsage["kind"],
	args: Omit<Parameters<typeof planCourse>[0], "engine" | "onStep" | "graph"> & { mode: PlannerMode },
): Promise<RunOutcome> {
	const engine = coursePlanner.resolveEngine();
	const run: PlannerRunUsage = { at: new Date().toISOString(), kind, model: `${engine.model.provider}:${engine.model.id}`, steps: [] };
	const outcome: RunOutcome = {};
	try {
		outcome.planned = await planCourse({
			...args,
			engine,
			...(graphToolsEnabled(effectiveSettings()) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
			onStep: (usage, model) => {
				run.model = model;
				run.steps.push(callUsage(usage));
			},
		});
	} catch (err) {
		outcome.error = err;
	}
	if (run.steps.length > 0) stores.courseStore.appendUsage(courseId, run);
	return outcome;
}

function rethrow(error: unknown, courseId?: string): never {
	if (error instanceof Error && error.name === "AbortError") throw new CourseError("Planning was cancelled.", 499, courseId);
	if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError || error instanceof CourseError) throw error;
	throw new CourseError(`Planning failed: ${error instanceof Error ? error.message : String(error)}`, 502, courseId);
}

function withSessions(planned: PlannedCourse["lessons"], previous: readonly CourseLesson[]): CourseLesson[] {
	const prev = new Map(previous.map((l) => [l.id, l]));
	return planned.map((l) => ({ ...l, sessionIds: prev.get(l.id)?.sessionIds ?? [] }));
}

function goalFields(goalInput: string, plannedGoal: string): Pick<CourseRecord, "goal" | "goalInferred"> {
	return goalInput.trim() ? { goal: goalInput.trim(), goalInferred: false } : { goal: plannedGoal, goalInferred: true };
}

export interface NewCourseInput {
	guideText: string;
	fileName?: string;
	goalInput: string;
	deadline: string;
	availabilityNotes: string;
}

function validateNewCourse(input: NewCourseInput, today: string): void {
	if (!input.guideText.trim()) throw new CourseError("The guide is empty — upload or paste a guide.", 400);
	if (new TextEncoder().encode(input.guideText).length > GUIDE_MAX_BYTES) {
		throw new CourseError(`The guide is larger than ${GUIDE_MAX_BYTES / 1024} KB.`, 400);
	}
	if (!isIsoDate(input.deadline)) throw new CourseError("The deadline must be a date (YYYY-MM-DD).", 400);
	if (input.deadline < today) throw new CourseError("The deadline is in the past.", 400);
}

/** Generate → a persisted DRAFT. The record exists before the run so every
 *  run's usage is captured; a first run that fails before any model call
 *  leaves nothing behind. */
export async function createCourseDraft(input: NewCourseInput, signal?: AbortSignal, now: Date = new Date()): Promise<CourseRecord> {
	const today = localDate(now);
	validateNewCourse(input, today);
	coursePlanner.resolveEngine(); // refuse before creating anything
	const pace = learnerPace(now);
	const draft = stores.courseStore.createCourse({
		title: titleFromPrompt(input.fileName?.replace(/\.[^.]+$/, "") || input.goalInput || "New course"),
		status: "draft",
		guide: { ...(input.fileName ? { fileName: input.fileName } : {}), text: input.guideText },
		goalInput: input.goalInput.trim(),
		goal: input.goalInput.trim(),
		goalInferred: !input.goalInput.trim(),
		deadline: input.deadline,
		availabilityNotes: input.availabilityNotes.trim(),
		lessons: [],
		feasibility: "",
		pace,
		usage: [],
	});
	const { planned, error } = await runPlanner(draft.id, "generate", {
		mode: "generate",
		guideText: input.guideText,
		goalInput: input.goalInput,
		deadline: input.deadline,
		availabilityNotes: input.availabilityNotes,
		today,
		pace,
		signal,
	});
	if (!planned) {
		const kept = stores.courseStore.getCourse(draft.id);
		if (kept && kept.usage.length === 0) {
			stores.courseStore.deleteCourse(draft.id);
			rethrow(error);
		}
		rethrow(error, draft.id);
	}
	const current = stores.courseStore.getCourse(draft.id) ?? draft;
	return stores.courseStore.saveCourse({
		...current,
		title: planned.title,
		...goalFields(input.goalInput, planned.goal),
		lessons: withSessions(planned.lessons, []),
		feasibility: planned.feasibility,
		pace,
	})!;
}

/** Regenerate a draft with optional feedback (replaces its lessons). */
export async function regenerateDraft(id: string, feedback: string, signal?: AbortSignal, now: Date = new Date()): Promise<CourseRecord> {
	const record = getCourseOr404(id);
	if (record.status !== "draft") throw new CourseError("Only a draft can be regenerated — use Replan on an active course.", 409);
	const today = localDate(now);
	if (record.deadline < today) throw new CourseError("The deadline has passed — set a new deadline first.", 400);
	const pace = learnerPace(now);
	const { planned, error } = await runPlanner(id, "regenerate", {
		mode: "generate",
		guideText: record.guide.text,
		goalInput: record.goalInput,
		deadline: record.deadline,
		availabilityNotes: record.availabilityNotes,
		today,
		pace,
		feedback,
		...(record.lessons.length > 0 ? { previous: { title: record.title, goal: record.goal, feasibility: record.feasibility, lessons: record.lessons } } : {}),
		signal,
	});
	if (!planned) rethrow(error, id);
	const current = getCourseOr404(id);
	return stores.courseStore.saveCourse({
		...current,
		title: planned.title,
		...goalFields(current.goalInput, planned.goal),
		lessons: withSessions(planned.lessons, []),
		feasibility: planned.feasibility,
		pace,
	})!;
}

/** Replan the not-done lessons into a PROPOSAL (no feedback → dates and
 *  estimates only; feedback → may restructure). */
export async function replanCourse(id: string, feedback: string, signal?: AbortSignal, now: Date = new Date()): Promise<CourseRecord> {
	const record = getCourseOr404(id);
	if (record.status !== "active") throw new CourseError("Accept the draft before replanning.", 409);
	const today = localDate(now);
	if (record.deadline < today) throw new CourseError("The deadline has passed — set a new deadline first.", 400);
	const chats = linkedChats(record.lessons);
	const done = record.lessons.filter((l) => lessonStatus(l, chats) === "done");
	const remaining = record.lessons.filter((l) => lessonStatus(l, chats) !== "done");
	if (remaining.length === 0) throw new CourseError("Every lesson is done — nothing to replan.", 400);
	const mode: PlannerMode = feedback.trim() ? "replan-restructure" : "replan-dates";
	const pace = learnerPace(now);
	const { planned, error } = await runPlanner(id, "replan", {
		mode,
		guideText: record.guide.text,
		goalInput: record.goal,
		deadline: record.deadline,
		availabilityNotes: record.availabilityNotes,
		today,
		pace,
		feedback,
		previous: { title: record.title, goal: record.goal, feasibility: record.feasibility, lessons: remaining },
		doneLessons: done,
		signal,
	});
	if (!planned) rethrow(error, id);
	const current = getCourseOr404(id);
	return stores.courseStore.saveCourse({
		...current,
		pendingReplan: {
			lessons: withSessions(planned.lessons, remaining),
			feasibility: planned.feasibility,
			pace,
			...(feedback.trim() ? { feedback: feedback.trim() } : {}),
			createdAt: now.toISOString(),
		},
	})!;
}

/** Apply the pending proposal: done lessons stay, the proposal replaces the rest. */
export function acceptReplan(id: string): CourseRecord {
	const record = getCourseOr404(id);
	const proposal = record.pendingReplan;
	if (!proposal) throw new CourseError("There is no pending replan.", 409);
	const chats = linkedChats(record.lessons);
	const proposedIds = new Set(proposal.lessons.map((l) => l.id));
	const current = new Map(record.lessons.map((l) => [l.id, l]));
	const done = record.lessons.filter((l) => !proposedIds.has(l.id) && lessonStatus(l, chats) === "done");
	// Sessions started while the proposal waited stay linked.
	const proposed = proposal.lessons.map((l) => ({ ...l, sessionIds: [...new Set([...l.sessionIds, ...(current.get(l.id)?.sessionIds ?? [])])] }));
	const lessons = [...done, ...proposed];
	const problems = lessonGraphProblems(lessons);
	if (problems.length > 0) throw new CourseError(problems.join(" "), 409);
	const { pendingReplan: _dropped, ...rest } = record;
	return stores.courseStore.saveCourse({ ...rest, lessons, feasibility: proposal.feasibility, pace: proposal.pace })!;
}

export function discardReplan(id: string): CourseRecord {
	const { pendingReplan: _dropped, ...rest } = getCourseOr404(id);
	return stores.courseStore.saveCourse(rest)!;
}

// ─── manual edits ────────────────────────────────────────────────────────────

function str(value: unknown, field: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) throw new CourseError(`${field} must be a non-empty string.`, 400);
	return value.trim();
}

/** PATCH a course: title, goal, deadline, availabilityNotes, status "active" (accept a draft). */
export function patchCourse(id: string, body: Record<string, unknown>, now: Date = new Date()): CourseRecord {
	const record = { ...getCourseOr404(id) };
	if (body.title !== undefined) record.title = str(body.title, "title");
	if (body.goal !== undefined) {
		record.goal = str(body.goal, "goal");
		record.goalInput = record.goal;
		record.goalInferred = false;
	}
	if (body.deadline !== undefined) {
		if (!isIsoDate(body.deadline)) throw new CourseError("deadline must be a date (YYYY-MM-DD).", 400);
		if (body.deadline < localDate(now)) throw new CourseError("The deadline is in the past.", 400);
		record.deadline = body.deadline;
	}
	if (body.availabilityNotes !== undefined) record.availabilityNotes = str(body.availabilityNotes, "availabilityNotes", true);
	if (body.status !== undefined) {
		if (body.status !== "active") throw new CourseError('status may only be set to "active".', 400);
		if (record.lessons.length === 0) throw new CourseError("A course needs at least one lesson.", 400);
		record.status = "active";
	}
	return stores.courseStore.saveCourse(record)!;
}

interface LessonFields {
	title?: unknown;
	goal?: unknown;
	guideSummary?: unknown;
	targetDate?: unknown;
	predictedNodes?: unknown;
	prerequisites?: unknown;
}

function applyLessonFields(lesson: CourseLesson, body: LessonFields, lessons: readonly CourseLesson[]): CourseLesson {
	const next = { ...lesson };
	if (body.title !== undefined) next.title = str(body.title, "title");
	if (body.goal !== undefined) next.goal = str(body.goal, "goal");
	if (body.guideSummary !== undefined) next.guideSummary = str(body.guideSummary, "guideSummary", true);
	if (body.targetDate !== undefined) {
		if (!isIsoDate(body.targetDate)) throw new CourseError("targetDate must be a date (YYYY-MM-DD).", 400);
		next.targetDate = body.targetDate;
	}
	if (body.predictedNodes !== undefined) {
		const n = body.predictedNodes;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_PREDICTED_NODES) {
			throw new CourseError(`predictedNodes must be an integer from 1 to ${MAX_PREDICTED_NODES}.`, 400);
		}
		next.predictedNodes = n;
	}
	if (body.prerequisites !== undefined) {
		if (!Array.isArray(body.prerequisites) || body.prerequisites.some((p) => typeof p !== "string")) {
			throw new CourseError("prerequisites must be a list of lesson ids.", 400);
		}
		const others = lessons.filter((l) => l.id !== lesson.id);
		const prereqs = [...new Set(body.prerequisites as string[])];
		for (const p of prereqs) {
			if (!lessons.some((l) => l.id === p)) throw new CourseError(`Unknown prerequisite "${p}".`, 400);
			if (wouldCycle([...others, { ...next, prerequisites: [] }], p, lesson.id)) {
				throw new CourseError(`"${p}" can't be a prerequisite — it would create a cycle.`, 400);
			}
		}
		next.prerequisites = prereqs;
	}
	return next;
}

function mutateLessons(id: string, mutate: (lessons: CourseLesson[]) => CourseLesson[]): CourseRecord {
	const record = getCourseOr404(id);
	const lessons = mutate(record.lessons);
	const problems = lessonGraphProblems(lessons);
	if (problems.length > 0) throw new CourseError(problems.join(" "), 400);
	return stores.courseStore.saveCourse({ ...record, lessons })!;
}

export function patchLesson(id: string, lessonId: string, body: LessonFields): CourseRecord {
	return mutateLessons(id, (lessons) => {
		const lesson = lessons.find((l) => l.id === lessonId);
		if (!lesson) throw new CourseError("Lesson not found", 404);
		const next = applyLessonFields(lesson, body, lessons);
		return lessons.map((l) => (l.id === lessonId ? next : l));
	});
}

export function addLesson(id: string, body: LessonFields): CourseRecord {
	return mutateLessons(id, (lessons) => {
		// A hand-added lesson states everything itself — no invented defaults.
		const title = str(body.title, "title");
		str(body.goal, "goal");
		if (body.targetDate === undefined) throw new CourseError("targetDate is required.", 400);
		if (body.predictedNodes === undefined) throw new CourseError("predictedNodes is required.", 400);
		const blank: CourseLesson = {
			id: lessonSlug(title, new Set(lessons.map((l) => l.id))),
			title,
			goal: "",
			guideSummary: "",
			prerequisites: [],
			targetDate: "",
			predictedNodes: 1,
			multiplier: 1,
			sessionIds: [],
		};
		return [...lessons, applyLessonFields(blank, body, [...lessons, blank])];
	});
}

/** Delete a lesson (its sessions stay) and drop it from every prerequisite list. */
export function deleteLesson(id: string, lessonId: string): CourseRecord {
	return mutateLessons(id, (lessons) => {
		if (!lessons.some((l) => l.id === lessonId)) throw new CourseError("Lesson not found", 404);
		return lessons
			.filter((l) => l.id !== lessonId)
			.map((l) => (l.prerequisites.includes(lessonId) ? { ...l, prerequisites: l.prerequisites.filter((p) => p !== lessonId) } : l));
	});
}

export function deleteCourse(id: string): void {
	if (!stores.courseStore.deleteCourse(id)) throw new CourseError("Course not found", 404);
}

// ─── lesson sessions ─────────────────────────────────────────────────────────

/** Start a teaching session for a lesson: create the chat, stamp its model,
 *  write the course-lesson marker as message[0], link it to the lesson.
 *  The client stashes `openingPrompt` and the chat page auto-sends it. */
export function startLessonSession(id: string, lessonId: string): { chatId: string; openingPrompt: string } {
	const record = getCourseOr404(id);
	if (record.status !== "active") throw new CourseError("Accept the draft before starting lessons.", 409);
	const lesson = record.lessons.find((l) => l.id === lessonId);
	if (!lesson) throw new CourseError("Lesson not found", 404);
	const titleOf = new Map(record.lessons.map((l) => [l.id, l.title]));
	const chat = stores.chatStore.createChat(titleFromPrompt(lesson.title));
	stampNewSessionModel(chat.id);
	stores.chatStore.saveMessages(chat.id, [
		newCourseLessonMessage({
			courseId: record.id,
			courseTitle: record.title,
			courseGoal: record.goal,
			lessonId: lesson.id,
			lessonTitle: lesson.title,
			lessonGoal: lesson.goal,
			buildsOn: lesson.prerequisites.map((p) => titleOf.get(p) ?? p),
			leadsInto: dependentsOf(record.lessons, lesson.id).map((d) => titleOf.get(d) ?? d),
			guideSummary: lesson.guideSummary,
		}),
	]);
	stores.courseStore.saveCourse({
		...record,
		lessons: record.lessons.map((l) => (l.id === lessonId ? { ...l, sessionIds: [...l.sessionIds, chat.id] } : l)),
	});
	return { chatId: chat.id, openingPrompt: lesson.goal };
}

// ─── transport helpers ───────────────────────────────────────────────────────

/** Map any course-seam failure to its HTTP response (the 503 config
 *  envelopes match the rest of the app's BYOK refusals). */
export function courseErrorResponse(err: unknown): Response {
	if (err instanceof CourseError) {
		return Response.json({ error: err.message, ...(err.courseId ? { courseId: err.courseId } : {}) }, { status: err.status });
	}
	if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
		return Response.json(err.envelope, { status: 503 });
	}
	console.error("[courses]", err);
	return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
}

/** Read the JSON body as a plain object ({} when absent or malformed). */
export async function courseJsonBody(req: Request): Promise<Record<string, unknown>> {
	const body: unknown = await req.json().catch(() => ({}));
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

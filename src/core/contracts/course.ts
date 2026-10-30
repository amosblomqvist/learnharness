/**
 * Course contracts — the multi-session curriculum (owner-approved plan,
 * 2026-10-30): a guide markdown + optional goal + deadline become a
 * DEPENDENCY GRAPH of lessons, each lesson launching ordinary teaching
 * sessions. Part of the domain-split contracts (src/core/contracts/).
 *
 * Derived, never stored: lesson completion folds from the linked
 * sessions (core/course-progress.ts) and lesson minutes fold from the
 * learner's measured pace (core/pace.ts). The record stores only the
 * planner's inputs (predictedNodes, multiplier) and a pace SNAPSHOT for
 * the "frozen" estimate mode.
 */

import type { CallUsage } from "./chat.ts";

/** The learner's measured pace, blended toward defaults (core/pace.ts). */
export interface PaceStats {
	/** Blended active minutes per plan node. */
	nodeMinutes: number;
	/** Blended active probe + plan minutes per session. */
	overheadMinutes: number;
	/** Measured plan nodes behind nodeMinutes. */
	measuredNodes: number;
	/** Measured sessions behind overheadMinutes. */
	measuredSessions: number;
	/** Average active minutes per week over the last 4 weeks. */
	weeklyMinutes: number;
	/** Average distinct study days per week over the last 4 weeks. */
	studyDaysPerWeek: number;
	computedAt: string;
}

export interface CourseLesson {
	/** Slug, stable across edits and replans. */
	id: string;
	title: string;
	/** What the learner should understand or be able to do. */
	goal: string;
	/** LLM-written condensation of the guide material this lesson covers. */
	guideSummary: string;
	/** Prerequisite lesson ids (edge prerequisite → this lesson). */
	prerequisites: string[];
	/** YYYY-MM-DD, learner-local. */
	targetDate: string;
	/** The planner's prediction of plan-tree nodes the tutor will need (int ≥ 1). */
	predictedNodes: number;
	/** LLM adjustment to the pace baseline, in [0.5, 2]; 1 = baseline. */
	multiplier: number;
	multiplierReason?: string;
	/** Linked teaching sessions — done if ANY is done. */
	sessionIds: string[];
}

/** A replan awaiting accept/discard. */
export interface CourseProposal {
	lessons: CourseLesson[];
	feasibility: string;
	pace: PaceStats;
	feedback?: string;
	createdAt: string;
}

/** One planner run's usage — EVERY run lands here, discarded drafts too. */
export interface PlannerRunUsage {
	at: string;
	kind: "generate" | "regenerate" | "replan";
	/** Provider-qualified ("provider:id"). */
	model: string;
	steps: CallUsage[];
}

export type CourseStatus = "draft" | "active";

export interface CourseRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	status: CourseStatus;
	guide: { fileName?: string; text: string };
	/** What the learner typed ("" when left blank). */
	goalInput: string;
	goal: string;
	goalInferred: boolean;
	/** YYYY-MM-DD. */
	deadline: string;
	availabilityNotes: string;
	lessons: CourseLesson[];
	feasibility: string;
	/** Snapshot at the last generation/accepted replan — the frozen-mode source. */
	pace: PaceStats;
	pendingReplan?: CourseProposal;
	usage: PlannerRunUsage[];
	/** Schema stamp — same discipline as ChatRecord.version. */
	version?: number;
}

/** The course record format this build writes and understands. */
export const CURRENT_COURSE_VERSION = 1;

export type LessonStatus = "done" | "in-progress" | "not-started";
export type CourseHealth = "on-track" | "behind";

/** How lesson minutes resolve their pace (global setting general.courseEstimates). */
export type CourseEstimateMode = "frozen" | "live";

/** Per-lesson minute breakdown — the tooltip's content. */
export interface LessonMinutes {
	overheadMinutes: number;
	nodeMinutes: number;
	predictedNodes: number;
	baselineMinutes: number;
	multiplier: number;
	multiplierReason?: string;
	minutes: number;
}

/** A lesson as the course page sees it: the record plus derived fields. */
export interface LessonView extends CourseLesson {
	status: LessonStatus;
	overdue: boolean;
	estimate: LessonMinutes;
	/** Linked sessions that still exist, with their titles. */
	sessions: Array<{ id: string; title: string; done: boolean }>;
}

/** GET /api/courses/:id payload. */
export interface CourseView {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	status: CourseStatus;
	guide: { fileName?: string; chars: number };
	goalInput: string;
	goal: string;
	goalInferred: boolean;
	deadline: string;
	availabilityNotes: string;
	feasibility: string;
	lessons: LessonView[];
	health: CourseHealth;
	doneCount: number;
	/** The pace the minutes were computed from (snapshot or live). */
	pace: PaceStats;
	estimateMode: CourseEstimateMode;
	pendingReplan?: Omit<CourseProposal, "lessons"> & { lessons: LessonView[] };
	/** Read-time dollars over every planner run (null-priced runs counted apart). */
	cost: { dollars: number; unpriced: number; runs: number };
}

/** GET /api/courses list item. */
export interface CourseListItem {
	id: string;
	title: string;
	status: CourseStatus;
	updatedAt: string;
	doneCount: number;
	lessonCount: number;
	health: CourseHealth;
}

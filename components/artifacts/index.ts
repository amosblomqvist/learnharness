import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { DemoCard } from "@/components/artifacts/demo-card";
import { JobCard, PdfJobCard } from "@/components/artifacts/job-card";
import { VisualCard } from "@/components/artifacts/visual-card";
import { ProbeDoneCard } from "@/components/artifacts/probe-done-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { ProblemCard, ConcludeCard } from "@/components/practice-cards";

/**
 * Artifact renderer registry — the extension point for tool-part UI.
 *
 * chat.tsx renders any tool part it doesn't specially handle (i.e. not
 * quiz/ask) by looking the tool name up here. Add your renderer — do NOT
 * edit chat.tsx (see docs/plan.md file-ownership rules).
 *
 * Typical shape: while the part is input-available render an activity card
 * (the chat view's jobs feed reads GET /api/jobs?chatId=…; on completion call
 * ChatActionsContext.syncFromServer()); when output-available render the
 * artifact itself from part.output.
 */
export const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>> = {
	research: JobCard,
	pdf: PdfJobCard, // sources v0 — live smoke 2026-09-19 caught the gap: without this the tool-pdf dispatch part rendered nothing
	// plan_* parts render nothing inline by design: the phase seam is a
	// message-level boundary, drawn by PhaseDivider in chat.tsx (the old
	// part-level plan_init divider retired with it).
	// Artifacts (W6 fills in the components):
	demo: DemoCard,
	visual: VisualCard,
	// The probe conclusion: the assessment belongs to the learner as much as
	// to the transcript (docs/probe-teach-split.md §2). Plain v1 card.
	probe_done: ProbeDoneCard,
	// The learner-filesystem set (sources v1): one quiet expandable
	// tool-call card each — collapsed one-liner (tool name + headline
	// argument), full input/output on expand.
	read: ToolCallCard,
	pdf_view: ToolCallCard, // page images / crops: gallery under the collapsed trace
	ls: ToolCallCard,
	find: ToolCallCard,
	grep: ToolCallCard,
	// The practice pair (2026-10-04): the pose renders the statement ONLY
	// (the commitment lives in the call's arguments and never renders);
	// the conclusion carries the outcome + verdict + the reveal.
	problem: ProblemCard,
	conclude: ConcludeCard,
	// The prober's graph tools (wave 7): same quiet expandable card —
	// collapsed one-liner (tool name + the session id for
	// list_propositions), the tool's own compact row-per-line output
	// (name / level / date) verbatim on expand, exactly the read/ls
	// discipline (their results are pre-formatted strings too).
	list_sessions: ToolCallCard,
	list_propositions: ToolCallCard,
};

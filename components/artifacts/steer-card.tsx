"use client";

import { CheckIcon, CircleX } from "lucide-react";
import type { PdfResult, ResearchResult, SubagentArtifactData } from "@/src/core";
import type { LhViewMessage } from "@/src/core";
import { isSubagentFailure } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { PdfBriefCard, ResearchBriefCard } from "@/components/artifacts/job-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { useT } from "@/components/locale";

/**
 * The sub-agent result delivery card (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * When a background job completes, the wake pipeline injects a STEER message
 * into the transcript: a user-role UIMessage whose data part
 * ("data-subagent-artifact") carries the result. It renders as an artifact —
 * NEVER a learner bubble, never wrapped in a message container:
 *
 *   research — a quiet "Research complete" one-liner that expands on demand
 *     (native <details>) to the full persisted brief + sources: the brief is
 *     too long to inline by default and the teacher's wake turn weaves it
 *     into the lesson anyway. Failures keep the failure card (the brief
 *     explains what went wrong).
 *   demo / visual — the artifact itself (sandboxed iframe / sanitized SVG).
 *     The sub-agent's verification notes are model-facing glue and do NOT
 *     render; only a failure note does.
 */
export function SubagentSteerCard({ message }: { message: LhViewMessage }) {
	const t = useT();
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	// The abort steer (2026-09 dock semantics): its message-type part is
	// data-subagent-aborted (the custom-message scheme — the part, not
	// metadata, is the marker) — a quiet chip, mirroring the complete-badge.
	if (!data) {
		const aborted = message.parts.find((p) => p.type === "data-subagent-aborted") as
			| { data?: { kind?: string } }
			| undefined;
		if (aborted?.data) return <AbortedBadge kind={aborted.data.kind ?? "job"} />;
		return (
				<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				{t("A sub-agent finished, but its result could not be displayed.")}
			</div>
		);
	}
	switch (data.kind) {
		case "research":
			return isSubagentFailure("research", data.result as ResearchResult) ? (
				<ResearchBriefCard output={data.result} />
			) : (
				<ResearchCompleteBadge result={data.result as ResearchResult} />
			);
		case "pdf":
			return isSubagentFailure("pdf", data.result as PdfResult) ? (
				<PdfBriefCard output={data.result} />
			) : (
				<PdfCompleteBadge result={data.result as PdfResult} />
			);
		case "demo":
			return <DemoOutputCard output={data.result} messageId={message.id} initialInverted={data.ui?.inverted ?? false} />;
		case "visual":
			return <VisualOutputCard output={data.result} messageId={message.id} initialInverted={data.ui?.inverted ?? false} />;
	}
}

/** The aborted-job chip: mirrors the complete-badge one-liner — the
 * teacher's wake turn acknowledges the abort in the lesson itself,
 * this just marks what happened. */
function AbortedBadge({ kind }: { kind: string }) {
	const t = useT();
	// The job kind is a raw enum value: t() is the display lookup, the raw value its fallback.
	return (
		<div data-testid="job-aborted-badge" className="flex items-center gap-2 text-xs text-muted-foreground">
			<CircleX className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{t(kind)}</span>
			<span>{t("aborted by the learner")}</span>
		</div>
	);
}

/** Quiet one-liner, the research-badge idiom ported to PDF: the brief is
 * too long to inline by default and the teacher's wake turn weaves it in;
 * the badge marks delivery, the collapsed details carries the full text
 * + consulted pages. */
function PdfCompleteBadge({ result }: { result: PdfResult }) {
	const t = useT();
	// The honest count is READ pages (extract/render — sources v1 split);
	// the ?? is runtime tolerance for pre-split persisted steers.
	const readPages = result.pagesRead ?? result.pagesConsulted;
	return (
		<details data-testid="pdf-complete-badge" className="group w-full text-xs text-muted-foreground">
			<summary className="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<CheckIcon className="size-3.5" />
				<span className="font-medium uppercase tracking-wide">PDF</span>
				<span>{t("reading complete")}</span>
				{readPages.length > 0 && (
					<span>
						· {t(readPages.length === 1 ? "read {n} page" : "read {n} pages", { n: readPages.length })}
					</span>
				)}
				<span className="ml-1 text-xs text-muted-foreground/70 group-open:hidden">{t("view brief")}</span>
				<span className="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">{t("hide brief")}</span>
			</summary>
			<div className="mt-2">
				<PdfBriefCard output={result} />
			</div>
		</details>
	);
}

/** Quiet one-liner, the dispatch-settled idiom — the lesson lives in the
 * teacher's wake turn; the badge just marks delivery. The persisted brief
 * rides along in a collapsed <details> (the wave-1 "view full research"
 * affordance): full markdown + sources, one click away, no extra fetch —
 * the artifact part in the record is the single source of truth. */
function ResearchCompleteBadge({ result }: { result: ResearchResult }) {
	const t = useT();
	const n = result.sources.length;
	return (
		<details data-testid="research-complete-badge" className="group w-full text-xs text-muted-foreground">
			<summary className="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<CheckIcon className="size-3.5" />
				<span className="font-medium uppercase tracking-wide">{t("Research")}</span>
				<span>{t("complete")}</span>
				{/* English keeps its "1 sources"; the singular key lets other languages agree. */}
				{n > 0 && <span>· {t(n === 1 ? "1 sources" : "{n} sources", { n })}</span>}
				<span className="ml-1 text-xs text-muted-foreground/70 group-open:hidden">{t("view brief")}</span>
				<span className="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">{t("hide brief")}</span>
			</summary>
			<div className="mt-2">
				<ResearchBriefCard output={result} />
			</div>
		</details>
	);
}

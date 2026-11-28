"use client";

import { CircleX } from "lucide-react";
import type { PdfResult, ResearchResult, SubagentArtifactData } from "@/src/core";
import type { LhViewMessage, PluginBackgroundResult, SubagentResultMeta } from "@/src/core";
import { isSubagentFailure } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { PdfBriefCard, ResearchBriefCard } from "@/components/artifacts/job-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { PluginWorkerCard } from "@/components/artifacts/plugin-worker-card";
import { WorkerResultDetails } from "@/components/artifacts/worker-result-presentation";
import { tr } from "@/src/core";

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
 *   plugin — the separate later task outcome, with an optional registered
 *     tool renderer and a persisted readable fallback (the call keeps its ack).
 */
export function SubagentSteerCard({ message }: { message: LhViewMessage }) {
	const artifactPart = message.parts.find((p) => p.type === "data-subagent-artifact");
	const data = artifactPart?.data as SubagentArtifactData | undefined;
	// The abort steer (2026-09 dock semantics): its message-type part is
	// data-subagent-aborted (the custom-message scheme — the part, not
	// metadata, is the marker) — a quiet chip, mirroring the complete-badge.
	if (!data) {
		const aborted = message.parts.find((p) => p.type === "data-subagent-aborted") as
			| { data?: { kind?: string; failure?: string } }
			| undefined;
		// Recovery/delivery failures share this marker family, but are not
		// learner aborts and do not invent an outcome for an unreadable task.
		if (typeof aborted?.data?.failure === "string") return (
			<div data-testid="job-delivery-failure" role="alert" className="space-y-1 rounded-xl border bg-card p-4 text-sm">
				<p className="font-medium">{tr("后台任务恢复或交付失败", "Background job recovery/delivery failed")}</p>
				<p className="whitespace-pre-wrap break-words text-muted-foreground">{aborted.data.failure}</p>
			</div>
		);
		if (aborted?.data) return <AbortedBadge kind={aborted.data.kind ?? "job"} />;
		return (
				<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				{tr("子智能体已完成，但无法显示其结果。", "A sub-agent finished, but its result could not be displayed.")}
			</div>
		);
	}
	switch (data.kind) {
		case "plugin": {
			const meta = (message.metadata as { subagentResult?: SubagentResultMeta } | undefined)?.subagentResult;
			return <PluginWorkerCard result={data.result as PluginBackgroundResult} toolCallId={meta?.toolCallId ?? ""} />;
		}
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
const ABORTED_KIND_LABEL: Record<string, string> = { research: "调研", demo: "互动演示", visual: "插图", pdf: "PDF", plugin: "插件", job: "后台任务" };

function AbortedBadge({ kind }: { kind: string }) {
	return (
		<div data-testid="job-aborted-badge" className="flex items-center gap-2 text-xs text-muted-foreground">
			<CircleX className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{tr(ABORTED_KIND_LABEL[kind] ?? kind, kind)}</span>
			<span>{tr("已被学习者中止", "aborted by the learner")}</span>
		</div>
	);
}

/** Quiet one-liner, the research-badge idiom ported to PDF: the brief is
 * too long to inline by default and the teacher's wake turn weaves it in;
 * the badge marks delivery, the collapsed details carries the full text
 * + consulted pages. */
function PdfCompleteBadge({ result }: { result: PdfResult }) {
	// The honest count is READ pages (extract/render — sources v1 split);
	// the ?? is runtime tolerance for pre-split persisted steers.
	const readPages = result.pagesRead ?? result.pagesConsulted;
	return (
		<WorkerResultDetails testId="pdf-complete-badge" heading={<>
				<span className="font-medium uppercase tracking-wide">PDF</span>
				<span>{tr("阅读完成", "reading complete")}</span>
				{readPages.length > 0 && (
					<span>
						{tr(<>· 已读 {readPages.length} 页</>, <>· read {readPages.length} page{readPages.length === 1 ? "" : "s"}</>)}
					</span>
				)}
			</>}>
			<PdfBriefCard output={result} />
		</WorkerResultDetails>
	);
}

/** Quiet one-liner, the dispatch-settled idiom — the lesson lives in the
 * teacher's wake turn; the badge just marks delivery. The persisted brief
 * rides along in a collapsed <details> (the wave-1 "view full research"
 * affordance): full markdown + sources, one click away, no extra fetch —
 * the artifact part in the record is the single source of truth. */
function ResearchCompleteBadge({ result }: { result: ResearchResult }) {
	return (
		<WorkerResultDetails testId="research-complete-badge" heading={<>
				<span className="font-medium uppercase tracking-wide">{tr("调研", "Research")}</span>
				<span>{tr("已完成", "complete")}</span>
				{result.sources.length > 0 && <span>· {result.sources.length} {tr("个来源", "sources")}</span>}
			</>}>
			<ResearchBriefCard output={result} />
		</WorkerResultDetails>
	);
}

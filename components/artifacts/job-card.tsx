"use client";

import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { MessageResponse } from "@/components/ai-elements/message";
import { useT } from "@/components/i18n";
import type { ArtifactPartProps, PdfResult, ResearchResult } from "@/src/core";

/**
 * The research tool-call box (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * The part's output is the fire-and-forget dispatch ACK — the box itself is
 * the DispatchCard (live status via the chat view's jobs feed; quiet one-liner
 * once delivered). The research brief itself no longer renders from the
 * tool part at all: it rides the steer message (the user-role delivery
 * injected after the wake turn) and renders there via ResearchBriefCard.
 */
export function JobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="research" />;
}

/**
 * The pdf dispatch box (sources v0) — the same async-protocol idiom as
 * JobCard: the ack output drives a DispatchCard (live "PDF reader" status
 * via the chat view's jobs feed); the brief itself rides the steer message
 * and renders under the PDF-complete badge in the transcript.
 */
export function PdfJobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="pdf" />;
}

/**
 * The PDF reading brief (sources v0) — markdown body + the consulted-pages
 * line. Exported: the steer card renders it under the PDF-complete badge,
 * the same expand-on-demand idiom as research.
 */
export function PdfBriefCard({ output }: { output: unknown }) {
	const t = useT();
	const result = output as PdfResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				{t("artifacts.pdf.unavailable")}
			</div>
		);
	}
	const failed = result.brief.startsWith("PDF failed");
	// Read = extract/render output entered the loop; consulted = every page
	// incl. search hits (the full audit set — the brief's citations may point
	// there). The ?? fallbacks tolerate pre-split persisted records.
	const readList = result.pagesRead ?? result.pagesConsulted ?? [];
	const consultedList = result.pagesConsulted ?? [];
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="pdf-brief-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{t("artifacts.pdf.briefLabel")}
				{failed && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">{t("artifacts.status.failed")}</span>}
			</div>
			<div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{!failed && readList.length > 0 && (
				<div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
					{t("artifacts.pdf.pagesRead", { pages: readList.join(", ") })}
				</div>
			)}
			{!failed && consultedList.length > readList.length && (
				<div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
					{t("artifacts.pdf.pagesConsulted", { pages: consultedList.join(", ") })}
				</div>
			)}
		</div>
	);
}

/**
 * The research brief — markdown body + a small source link list. Exported:
 * the steer card (sub-agent result delivery) renders the same artifact.
 */
export function ResearchBriefCard({ output }: { output: unknown }) {
	const t = useT();
	const result = output as ResearchResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				{t("artifacts.research.unavailable")}
			</div>
		);
	}
	const failed = result.brief.startsWith("Research failed");
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="research-brief-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{t("artifacts.research.briefLabel")}
				{failed && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">{t("artifacts.status.failed")}</span>}
			</div>
			<div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{result.sources.length > 0 && (
				<div className="mt-3 border-t pt-2">
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("artifacts.research.sources")}</div>
					<ul className="flex flex-col gap-0.5 text-xs">
						{result.sources.map((s) => (
							<li key={s.url} className="truncate">
								<a
									href={s.url}
									target="_blank"
									rel="noopener noreferrer"
									className="text-primary underline-offset-2 hover:underline"
								>
									{s.title}
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

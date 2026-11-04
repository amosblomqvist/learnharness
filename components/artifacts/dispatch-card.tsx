"use client";

import { useContext, useRef, useState, type ReactNode } from "react";
import { CheckIcon, SettingsIcon, XIcon } from "lucide-react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { isModelsRefusal, isProviderKeyRefusal, type JobKind, type JobRecord } from "@/src/core";
import { latestJobAttempt } from "@/components/job-attempt";
import { BrailleSpinner } from "@/components/braille-spinner";

/**
 * The dispatch card (contracts.ts "THE ASYNC PROTOCOL" §4): the tool-call
 * box for a background sub-agent. The tool part's output is the FIRE-AND-
 * FORGET ACK (a string) — never the result. Live status comes from the
 * chat-view jobs feed via JobsContext, matched by toolCallId:
 *
 *   job unknown → "dispatched" pulse (the jobs feed hasn't seen it yet)
 *   running     → live activity card (activity line + elapsed)
 *   done/error  → quiet one-liner ("finished" / "failed") — the artifact
 *                 itself arrives in the steer message right below, so the
 *                 box must not duplicate it.
 */
const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
};

export function DispatchCard({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const ctx = useContext(ChatActionsContext);
	const [accepted, setAccepted] = useState<JobRecord | null>(null);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);
	const inFlight = useRef(false);
	const candidates = accepted && accepted.chatId === ctx?.chatId && accepted.toolCallId === toolCallId && !jobs.some((j) => j.id === accepted.id)
		? [...jobs, accepted] : jobs;
	const job = latestJobAttempt(candidates, toolCallId);
	async function retry() {
		if (!ctx || !job || inFlight.current) return;
		inFlight.current = true;
		setRetrying(true);
		setRetryError(null);
		try {
			const response = await fetch("/api/jobs", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: ctx.chatId, jobId: job.id }),
			});
			const data = await response.json() as { job?: JobRecord; error?: string };
			if (!response.ok || !data.job) throw new Error(data.error || "Could not retry the demo. Try again.");
			setAccepted(data.job);
		} catch (error) {
			setRetryError(error instanceof Error ? error.message : "Could not retry the demo. Try again.");
		} finally {
			inFlight.current = false;
			setRetrying(false);
		}
	}
	const retryAction = kind === "demo" && job?.status === "error" && ctx ? <>
		<button type="button" data-testid="dispatch-retry" disabled={retrying} onClick={() => void retry()}
			className="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50 disabled:opacity-50">
			{retrying ? "Retrying…" : "Retry"}
		</button>
		{retryError && <span role="alert" className="text-red-500">{retryError}</span>}
	</> : null;
	const label = KIND_LABEL[kind];

	if (!job || job.status === "running") {
		return <DispatchActivityCard job={job} label={label} />;
	}
	// BYOK (owner, 2026-09-22): a job refused for missing models is INFO,
	// not scary-error — gray glyph + "needs model setup" + the deep-link
	// into the SetupDialog (the same flow the send interception uses).
	// The provider-key refusal twin (zero-keys wave): a pinned model
	// whose key is gone reads as the key being needed — the deep-link
	// lands on the SetupDialog's first-key stage on its own.
	if (isModelsRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs model setup" button="Set up models">{retryAction}</DispatchRefusedCard>;
	}
	if (isProviderKeyRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs a provider key" button="Add a key">{retryAction}</DispatchRefusedCard>;
	}
	const failed = job.status === "error";
	return (
		<div
			className="flex items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-settled"
		>
			{failed ? <XIcon className="size-3.5 text-red-500" /> : <CheckIcon className="size-3.5" />}
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{failed ? "failed" : "finished"}</span>
			{retryAction}
		</div>
	);
}

/** The refused card: quiet info tone — nothing red, nothing "failed". */
function DispatchRefusedCard({ label, line, button, children }: { label: string; line: string; button: string; children?: ReactNode }) {
	const ctx = useContext(ChatActionsContext);
	return (
		<div
			className="flex items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-refused"
		>
			<SettingsIcon className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{line}</span>
			{ctx && (
				<button
					type="button"
					data-testid="dispatch-setup-link"
					onClick={ctx.openSetup}
					className="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50"
				>
					{button}
				</button>
			)}
			{children}
		</div>
	);
}

function DispatchActivityCard({ job, label }: { job: JobRecord | null; label: string }) {
	// Elapsed from createdAt — jobs appear here only via the jobs feed (post-mount),
	// so no SSR/hydration mismatch.
	const elapsed =
		job && job.createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000)) : null;
	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid="dispatch-card"
		>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The working-state grammar (owner, streaming round 2026-10-01):
				    the Braille spinner replaces the pulsing dot — one indicator
				    everywhere. This is the ONLY dispatch-card change; the card's
				    shape is untouched. */}
				<BrailleSpinner label={`${label} running`} />
				{label}
				{elapsed !== null && <span className="font-normal">· {elapsed}s</span>}
			</div>
			{job?.activity && (
				<div className="mt-1 truncate text-sm text-muted-foreground" data-testid="dispatch-activity-line">
					{job.activity}
				</div>
			)}
			{!job && (
				<div className="mt-1 text-sm text-muted-foreground" data-testid="dispatch-pending">
					Dispatched…
				</div>
			)}
		</div>
	);
}

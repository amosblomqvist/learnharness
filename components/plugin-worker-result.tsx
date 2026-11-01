"use client";

import type { ReactNode } from "react";
import { CircleX } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { WorkerResultDetails } from "@/components/artifacts/worker-result-presentation";

/** Host presentation shared by persisted worker results and the plugin widget.
 * Rich bodies may replace the text, never the host identity/status. */
export function PluginWorkerResultSurface({ label, status, text, children, presentation = "collapsed" }: {
	label: string;
	status: "succeeded" | "failed" | "cancelled" | "interrupted";
	text: string;
	children?: ReactNode;
	presentation?: "collapsed" | "card" | "plain";
}) {
	const heading = <>
		<span className="font-medium uppercase tracking-wide">Background result</span>
		<span className="font-medium tracking-wide text-foreground">{label}</span>
		<span>{status}</span>
	</>;
	const body = children ?? <div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"><MessageResponse>{text}</MessageResponse></div>;
	if (presentation === "card") return (
		<div data-testid="plugin-worker-result-card" className="rounded-xl border bg-card p-4 text-card-foreground">
			<div data-testid="plugin-worker-header" className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">{heading}</div>
			{body}
		</div>
	);
	if (presentation === "plain") return (
		<div data-testid="plugin-worker-result-plain">
			<div data-testid="plugin-worker-header" className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">{heading}</div>
			{body}
		</div>
	);
	return (
		<WorkerResultDetails
			testId="plugin-worker-result"
			headerTestId="plugin-worker-header"
			heading={heading}
			{...(status !== "succeeded" ? { icon: <CircleX className="size-3.5" /> } : {})}
			viewLabel="view result"
			hideLabel="hide result"
		>
			{body}
		</WorkerResultDetails>
	);
}

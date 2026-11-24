"use client";

import type { ReactNode } from "react";
import { CheckIcon, CircleX, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { WorkerResultDetails } from "@/components/artifacts/worker-result-presentation";
import { Hint } from "@/components/ui/hint";

/** Host presentation shared by persisted worker results and the plugin widget.
 * Rich bodies may replace the text, never the host identity/status. */
export function PluginWorkerResultSurface({ label, status, text, children, presentation = "collapsed" }: {
	label: string;
	status: "succeeded" | "failed" | "cancelled" | "interrupted";
	text: string;
	children?: ReactNode;
	presentation?: "collapsed" | "card" | "plain";
}) {
	const icon = status === "succeeded" ? <CheckIcon aria-hidden="true" className="size-3.5" />
		: status === "failed" ? <XIcon aria-hidden="true" className="size-3.5 text-error" />
			: <CircleX aria-hidden="true" className="size-3.5" />;
	const tooltip = `${label}: ${status}`;
	const heading = <>
		<span className="font-medium tracking-wide text-foreground">{label}</span>
		<span className="sr-only"> {status}</span>
	</>;
	const body = children ?? <div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"><MessageResponse>{text}</MessageResponse></div>;
	if (presentation === "card") return (
		<div data-testid="plugin-worker-result-card" className="rounded-xl border bg-card p-4 text-card-foreground">
			<Hint label={tooltip}><div data-testid="plugin-worker-header" className="relative mb-1 flex items-center gap-2 text-xs text-muted-foreground">{icon}{heading}</div></Hint>
			{body}
		</div>
	);
	if (presentation === "plain") return (
		<div data-testid="plugin-worker-result-plain">
			<Hint label={tooltip}><div data-testid="plugin-worker-header" className="relative mb-1 flex items-center gap-2 text-xs text-muted-foreground">{icon}{heading}</div></Hint>
			{body}
		</div>
	);
	return (
		<WorkerResultDetails
			testId="plugin-worker-result"
			headerTestId="plugin-worker-header"
			heading={heading}
			icon={icon}
			headerTooltip={tooltip}
			disclosure="chevron"
		>
			{body}
		</WorkerResultDetails>
	);
}

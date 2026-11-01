"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";

/** Shared research/PDF completion grammar. The host owns the summary; only
 * the expanded body is replaceable by a plugin renderer. */
export function WorkerResultDetails({ heading, children, icon = <CheckIcon className="size-3.5" />, testId, headerTestId, viewLabel = "view brief", hideLabel = "hide brief" }: {
	heading: ReactNode;
	children: ReactNode;
	icon?: ReactNode;
	testId?: string;
	headerTestId?: string;
	viewLabel?: string;
	hideLabel?: string;
}) {
	return (
		<details data-testid={testId} className="group w-full text-xs text-muted-foreground">
			<summary data-testid={headerTestId} className="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				{icon}
				{heading}
				<span className="ml-1 text-xs text-muted-foreground/70 group-open:hidden">{viewLabel}</span>
				<span className="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">{hideLabel}</span>
			</summary>
			<div className="mt-2">{children}</div>
		</details>
	);
}

"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale";
import { cn } from "@/lib/utils";
import type { MermaidErrorComponentProps } from "streamdown";

/**
 * Fallback for mermaid diagrams that fail to parse — wired via Streamdown's
 * `mermaid.errorComponent`. Replaces the default light-themed red box with a
 * card matching the app: the error, the source in a details block (so a
 * broken diagram doesn't flood the transcript), and a retry.
 */
export const MermaidError = ({
	chart,
	error,
	retry,
	className,
}: MermaidErrorComponentProps & { className?: string }) => {
	const t = useT();
	return (
	<div
		className={cn(
			"my-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4",
			className,
		)}
		data-streamdown="mermaid-error"
	>
		<p className="text-sm font-medium text-destructive">
			{t("Diagram failed to render")}
		</p>
		<p className="mt-1 font-mono text-xs break-words text-muted-foreground">
			{error}
		</p>
		<details className="mt-3">
			<summary className="cursor-pointer text-xs text-muted-foreground">
				{t("Show diagram source")}
			</summary>
			<pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">
				{chart}
			</pre>
		</details>
		<Button className="mt-3" onClick={retry} size="sm" variant="outline">
			{t("Retry")}
		</Button>
	</div>
	);
};

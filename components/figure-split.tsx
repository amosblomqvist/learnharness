"use client";

import type { ReactNode } from "react";
import { VisualOutputCard } from "@/components/artifacts/visual-card";

/**
 * The question-figure layout (owner, 2026-10-27), shared by the dock and the
 * answered card: head + body left, the figure right; below `sm` it stacks in
 * DOM order — head, figure, body. No figure: exactly the old DOM.
 */
export function FigureSplit({
	figure,
	head,
	children,
	bodyClassName,
}: {
	figure?: string;
	head: ReactNode;
	children: ReactNode;
	bodyClassName?: string;
}) {
	if (!figure) {
		return (
			<>
				{head}
				{children}
			</>
		);
	}
	return (
		<div className="grid gap-x-4 sm:grid-cols-2 sm:grid-rows-[auto_1fr]" data-testid="figure-split">
			<div>{head}</div>
			<div className="sm:col-start-2 sm:row-span-2 sm:row-start-1">
				<VisualOutputCard output={{ svg: figure }} />
			</div>
			<div className={bodyClassName}>{children}</div>
		</div>
	);
}

"use client";

import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import type { SideQuestionDetails } from "@/src/core";

const CHIP_TEXT_MAX = 80;

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > CHIP_TEXT_MAX ? `${flat.slice(0, CHIP_TEXT_MAX).trimEnd()}…` : flat;
}

/** A closed side thread in the transcript (#16): a pill centred at its
 *  position. Clicking reopens the thread read-only; a thread kept private
 *  offers "Tell tutor" below the pill. */
export function SideQuestionChip({ details, onOpen, onTell }: {
	details: SideQuestionDetails;
	onOpen: (element: HTMLElement) => void;
	/** Resolves true once the note is on its way to the tutor. */
	onTell: () => Promise<boolean>;
}) {
	const [telling, setTelling] = useState(false);
	// Accepted (saved, or parked behind a turn or a waiting question): it
	// will reach the tutor, so the chip says so at once.
	const [toldNow, setToldNow] = useState(false);
	const told = details.toldTutor || toldNow;
	const first = details.thread[0];
	if (!first) return null;
	const passage = details.thread.find((pair) => pair.passage)?.passage;
	return (
		<div className="my-4 flex flex-col items-center gap-1" data-testid="side-question-chip-row">
			<button
				type="button"
				data-testid="side-question-chip"
				onClick={(event) => onOpen(event.currentTarget)}
				className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 font-prose text-sm text-foreground transition-colors hover:bg-accent"
			>
				<MessageCircleQuestion aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">
					Side question: {clip(first.question)}
					{passage && <span className="italic text-muted-foreground"> “{clip(passage)}”</span>}
					{told && <span className="text-muted-foreground"> · told tutor</span>}
				</span>
			</button>
			{!told && (
				<button
					type="button"
					data-testid="side-question-tell"
					disabled={telling}
					onClick={() => {
						setTelling(true);
						void onTell().then((ok) => { if (ok) setToldNow(true); }).finally(() => setTelling(false));
					}}
					className="cursor-pointer font-ui text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-default disabled:opacity-60"
				>
					Tell tutor
				</button>
			)}
		</div>
	);
}

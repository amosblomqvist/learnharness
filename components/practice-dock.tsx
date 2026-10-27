"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { cn } from "@/lib/utils";

/**
 * The practice dock (practice sessions, owner design 2026-10-04): an
 * ACTIVE problem replaces the chat composer — the persistent bottom blob
 * morphs into the problem. The agent's statement above; the learner's
 * half below — "Your thinking", a labeled field with ONE Send button
 * (owner round 2, 2026-10-05): Enter sends, Shift+Enter makes a newline.
 * There are no lanes — whether a submission claims an answer is apparent
 * from the thinking itself; the agent reads it. One problem may carry
 * many submissions; each starts a turn.
 *
 * Collapse (scroll-up → slim bar) is owned by the DockOverlay; this
 * component is content only, and the expanded form stays MOUNTED while
 * collapsed (hidden) so a half-written trace survives scrolling.
 *
 * The commitment (modelSolution, decisionPoints, …) rides the tool call's
 * arguments and is NOT rendered here — only the statement is the
 * learner's. Esc dismisses the problem (the layered-Esc chain; the
 * confirm dialog then the silent route) — claimed by the page, not here.
 */

export interface PracticeDockProps {
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The pose's arguments — only the statement is the learner's (the
	 *  mode badge would edge toward announcing the target; dropped). */
	input: { statement: string };
	/** Collapse state, owned by the DockOverlay. */
	expanded: boolean;
	onExpand: () => void;
	/** text — POST {type:"thinking"} (one lane; the register is read from the text). */
	onSubmit: (text: string) => void;
	/** Escape in the thinking field stops dictation (threaded from the page). */
	onEscape?: () => void;
	/** Compaction is running for this chat (owner round 14): the thinking
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
}

export function PracticeDock({ problemCallId, input, expanded, onExpand, onSubmit, onEscape, compactionRunning = false }: PracticeDockProps) {
	const [thinking, setThinking] = useState("");
	// Ref MIRRORS the field ("nothing gets lost", the question-dock
	// discipline): a submit resuming after `await finishDictation()` reads
	// the tail, never a stale closure.
	const thinkingRef = useRef("");

	useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(thinkingRef.current, t);
				thinkingRef.current = v;
				setThinking(v);
			},
			[],
		),
		true,
	);

	const submit = () => {
		if (compactionRunning) return;
		const text = thinkingRef.current.trim();
		if (text.length === 0) return;
		thinkingRef.current = "";
		setThinking("");
		onSubmit(text);
	};

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): dictation
	 * means the field is often never focused — the window-level Enter
	 * (typing surfaces and buttons excluded) submits the trace. Mounted
	 * while the dock is — collapsed bar included (the trace survives). */
	useEnterSubmits(submit);

	/* ── the collapsed bar ── */
	if (!expanded) {
		return (
			<button
				type="button"
				data-testid="practice-dock-bar"
				onClick={onExpand}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon className="size-4 shrink-0 rotate-90" />
				<span className="font-medium">Problem</span>
				<span className="min-w-0 flex-1 truncate">{input.statement}</span>
			</button>
		);
	}

	/* ── the expanded form ── */
	return (
		<div data-testid="practice-dock" data-problem={problemCallId}>
			{/* The agent's half: the 'Problem' eyebrow (mirroring the quiz
			    cards' label row — owner round, 2026-10-05) + the statement,
			    markdown + LaTeX rendered, capped by the measured column
			    (--dock-max-h; the old fixed 40vh cut long problems short). */}
			<div data-dock-scroll="" className="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
				<div className="lh-prose text-[15px]">
					<ToolContentResponse>{input.statement}</ToolContentResponse>
				</div>
			</div>

			{/* The learner's half: Enter SENDS (owner round 2, 2026-10-05);
			    Shift+Enter makes a newline — less to decide about. */}
			<div
				data-testid="practice-thinking-field"
				className="m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
			>
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					YOUR THINKING
				</div>
				<textarea
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
					}}
					onKeyDown={(e) => {
						// Esc ends dictation — stopPropagation claims it (the
						// keyboard machine) so the window chain doesn't also fire.
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// Enter SENDS — the single lane (owner round 2, 2026-10-05);
						// Shift+Enter is the newline, ⌘/Ctrl+Enter the chord too.
						if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder="Work here, think out loud."
					rows={4}
					className={cn(
						"field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground",
					)}
				/>
				{/* The submit row (owner round 4, 2026-10-05): IDENTICAL to the
				    question dock's — hint left, the SAME Button (h-9, px-3.5),
				    one p-1 row. Corner radii concentric: shell 16 − m-1.5 (6) =
				    field 10 − p-1 (4) = button 6. */}
				<div className="flex items-center justify-between gap-2 p-1">
					<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
						{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
					</span>
					<Button
						type="button"
						data-testid="practice-send"
						disabled={thinking.trim().length === 0 || compactionRunning}
						onClick={() => submit()}
						className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
					>
						Submit thinking
					</Button>
				</div>
			</div>
		</div>
	);
}

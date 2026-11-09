"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, MessageCircleQuestionIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { AsideThread } from "@/src/core";

/**
 * THE ASIDE PANEL (issue #16 — "/btw"-style side questions): a persistent,
 * visually secondary thread above the composer. It renders
 * ChatRecord.asides — NEVER the main transcript — so a quick clarification
 * is one click away without polluting the lesson. Collapsed by default (a
 * quiet toggle row); opening lists the Q/A history and offers the input.
 *
 * The busy contract: asides are refused server-side while a main turn runs
 * (the chat file belongs to that turn). The panel mirrors that honestly —
 * the input disables and the note says to ask after the current reply —
 * instead of letting the POST 409.
 */

/** The input's gating note, pure for tests. null = askable. */
export function asideDisabledNote(busy: boolean, asking: boolean): string | null {
	if (busy) return "A reply is being written — ask after the current reply.";
	if (asking) return "Answering your aside…";
	return null;
}

export function AsidePanel({
	thread,
	busy,
	asking,
	error,
	onAsk,
}: {
	/** The session's aside thread (v1: the record's single thread), or null
	 *  before the first question. */
	thread: AsideThread | null;
	/** A main turn is in flight (composer busy) — the server refuses asides. */
	busy: boolean;
	/** An aside POST is in flight (this client asked). */
	asking: boolean;
	/** The last ask's failure text, if any. */
	error: string | null;
	/** Submit a question (trimmed, non-empty). */
	onAsk: (text: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const note = asideDisabledNote(busy, asking);
	const askable = note === null;
	const questionCount = thread ? thread.messages.filter((m) => m.role === "user").length : 0;

	const submit = () => {
		const t = draft.trim();
		if (!t || !askable) return;
		setDraft("");
		onAsk(t);
	};

	return (
		<div className="flex flex-col items-end gap-1 pb-1" data-testid="aside-panel">
			<button
				type="button"
				data-testid="aside-toggle"
				onClick={() => setOpen(!open)}
				className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 font-ui text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
			>
				<MessageCircleQuestionIcon className="size-3.5" />
				Ask aside{questionCount > 0 ? ` (${questionCount})` : ""}
				{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
			</button>
			{open && (
				<div className="w-full max-w-[26rem] rounded-md border border-border/60 bg-card/60 p-2 shadow-sm">
					{thread && thread.messages.length > 0 && (
						<div
							data-testid="aside-thread"
							className="mb-2 flex max-h-44 flex-col gap-2 overflow-y-auto pr-1"
						>
							{thread.messages.map((m, i) =>
								m.role === "user" ? (
									<p key={i} className="text-xs leading-relaxed text-foreground/85">
										<span className="font-medium text-muted-foreground">Q:</span> {m.text}
									</p>
								) : (
									<p key={i} className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
										<span className="font-medium">A:</span> {m.text}
									</p>
								),
							)}
						</div>
					)}
					<div className="flex items-end gap-1.5">
						<textarea
							data-testid="aside-input"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation(); // claims Esc: closing the panel, not the abort chain
									setOpen(false);
									return;
								}
								// The submission convention: Enter submits, Shift+Enter newlines.
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submit();
								}
							}}
							rows={1}
							placeholder="Quick clarification — kept out of the lesson…"
							disabled={!askable}
							className="field-sizing-content lh-input max-h-24 min-h-8 flex-1 resize-none rounded-sm bg-transparent px-1.5 py-1 font-ui text-xs outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
						/>
						<button
							type="button"
							data-testid="aside-send"
							aria-label="Ask aside"
							onClick={submit}
							disabled={!askable || draft.trim().length === 0}
							className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
						>
							{asking ? <BrailleSpinner className="h-3" label="Answering your aside" /> : <MessageCircleQuestionIcon className="size-3.5" />}
						</button>
					</div>
					{note && (
						<p data-testid="aside-note" className="mt-1.5 flex items-center gap-1.5 font-ui text-[11px] text-muted-foreground/70">
							{busy ? null : <BrailleSpinner className="h-2.5" label="Answering your aside" />}
							{note}
						</p>
					)}
					{error && (
						<p role="alert" data-testid="aside-error" className="mt-1 font-ui text-[11px] text-destructive">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

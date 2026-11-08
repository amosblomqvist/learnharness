"use client";

import { useState } from "react";

/**
 * THE QUEUED-STEER INDICATOR (owner spec 2026-10-03): steers sent but not
 * yet drained render as quiet one-liners ABOVE the composer shell —
 * right-aligned to where the shell's corner rounding starts, truncated
 * with an ellipsis, no background, no container, roughly half opacity.
 * Visible but very quiet; layout tunable later.
 *
 * A line dies the moment its card lands in the transcript: the drain's
 * verbatim message events upsert the real user card by the client-minted
 * id, and visibleQueuedSteers (session-core, pure) filters the queue
 * against the message ids. A steer parked server-side (stranded behind a
 * question) keeps its line — an honest "waiting for the next run".
 *
 * EDITING (issue #321): given `onEdit`, a line is clickable and becomes an
 * inline field — Enter saves (blank text cancels the steer), Esc or a
 * click away discards. Without `onEdit` the lines stay read-only.
 */
export interface QueuedSteerLine {
	id: string;
	text: string;
}

const LINE_CLASS = "block max-w-[240px] truncate font-ui text-[11px] text-muted-foreground/60";

/** What a key does inside the edit field: Enter saves, Esc cancels. An Enter
 *  that confirms an IME composition is part of the typing, not a save. */
export function steerEditKey(e: { key: string; isComposing?: boolean }): "save" | "cancel" | null {
	if (e.isComposing) return null;
	if (e.key === "Enter") return "save";
	if (e.key === "Escape") return "cancel";
	return null;
}

/** The inline field for one queued steer. Both keys are claimed at the
 *  element (the one-Esc law): Esc closing the edit must not also open the
 *  turn-abort confirm. Blur discards — only Enter ever sends. */
export function QueuedSteerEditor({
	initial,
	onSave,
	onCancel,
}: {
	initial: string;
	onSave: (text: string) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(initial);
	return (
		<input
			autoFocus
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				const action = steerEditKey({ key: e.key, isComposing: e.nativeEvent.isComposing });
				if (!action) return;
				e.stopPropagation();
				e.preventDefault();
				if (action === "save") onSave(draft);
				else onCancel();
			}}
			onBlur={onCancel}
			spellCheck={false}
			aria-label="Edit queued message"
			className="w-[240px] bg-transparent text-right font-ui text-[11px] text-foreground outline-none"
		/>
	);
}

function QueuedSteerItem({ steer, onEdit }: { steer: QueuedSteerLine; onEdit?: (id: string, text: string) => void }) {
	const [editing, setEditing] = useState(false);
	if (!onEdit) {
		return (
			<span title={steer.text} className={LINE_CLASS}>
				{steer.text}
			</span>
		);
	}
	if (editing) {
		return (
			<QueuedSteerEditor
				initial={steer.text}
				onSave={(text) => {
					setEditing(false);
					onEdit(steer.id, text);
				}}
				onCancel={() => setEditing(false)}
			/>
		);
	}
	return (
		<button
			type="button"
			title={steer.text}
			aria-label="Edit queued message"
			onClick={() => setEditing(true)}
			className={`${LINE_CLASS} cursor-text text-right`}
		>
			{steer.text}
		</button>
	);
}

/** The body (SSR-pinnable): one right-aligned truncated line per queued
 *  steer, stacked. */
export function QueuedSteersBody({
	steers,
	onEdit,
}: {
	steers: QueuedSteerLine[];
	/** (id, text) — text is blank when the learner emptied the field. */
	onEdit?: (id: string, text: string) => void;
}) {
	if (steers.length === 0) return null;
	return (
		<div className="flex flex-col items-end gap-0.5 pb-1 pr-4" data-testid="queued-steers">
			{steers.map((s) => (
				<QueuedSteerItem key={s.id} steer={s} onEdit={onEdit} />
			))}
		</div>
	);
}

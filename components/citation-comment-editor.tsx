"use client";

import { useEffect, useRef, useState } from "react";
import { CITATION_MAX_COMMENT_LENGTH } from "@/src/core";
import { Button } from "./ui/button";

/**
 * THE CITATION COMMENT EDITOR (2026-10-31; behaviour follows T3 Code's
 * citation comment editor, MIT). Enter saves, ⌘/Ctrl+Enter saves and
 * sends, Shift+Enter is a newline, Escape cancels. Clicking away or moving
 * focus out commits a typed draft; an over-length draft keeps the popover
 * open rather than being dropped.
 */

export type CommentDismissal = "escape" | "outside" | "focus-out";

export function commentDismissalOutcome({ reason, draft, saved }: {
	reason: CommentDismissal;
	/** null = nothing typed since opening. */
	draft: string | null;
	saved: string | undefined;
}): "close" | "commit" | "keep-open" {
	if (reason === "escape" || draft === null) return "close";
	if (draft.trim() === (saved ?? "").trim()) return "close";
	if (draft.length > CITATION_MAX_COMMENT_LENGTH) return "keep-open";
	return "commit";
}

export function commentKeyAction(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }): "save" | "save-send" | "cancel" | null {
	if (event.isComposing) return null;
	if (event.key === "Escape") return "cancel";
	if (event.key !== "Enter" || event.shiftKey) return null;
	return event.metaKey || event.ctrlKey ? "save-send" : "save";
}

export function CitationCommentEditor({ initial, onDraftChange, onSave, onCancel }: {
	initial: string | undefined;
	/** Every keystroke, so the dismissal policy can commit what was typed. */
	onDraftChange: (draft: string) => void;
	onSave: (comment: string, andSend: boolean) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(initial ?? "");
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const tooLong = draft.length > CITATION_MAX_COMMENT_LENGTH;
	useEffect(() => { areaRef.current?.focus(); }, []);
	return (
		<div className="flex flex-col gap-2">
			<textarea
				ref={areaRef}
				value={draft}
				rows={2}
				aria-label="Comment on selected text"
				aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
				placeholder="Add an optional comment..."
				className="field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
				onChange={(event) => { setDraft(event.target.value); onDraftChange(event.target.value); }}
				onKeyDown={(event) => {
					const action = commentKeyAction({ ...event, isComposing: event.nativeEvent.isComposing || event.keyCode === 229 });
					if (action === null) return;
					event.preventDefault();
					event.stopPropagation();
					if (action === "cancel") onCancel();
					else if (!tooLong) onSave(draft, action === "save-send");
				}}
			/>
			{tooLong ? (
				<p role="status" className="text-xs text-destructive">Comments can contain up to 8,000 characters.</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button type="button" size="xs" variant="outline" onPointerDown={(event) => event.preventDefault()} onClick={onCancel}>Cancel</Button>
				<Button type="button" size="xs" disabled={tooLong} onPointerDown={(event) => event.preventDefault()} onClick={() => onSave(draft, false)}>
					{tooLong ? "Shorten comment" : "Save"}
				</Button>
			</div>
		</div>
	);
}

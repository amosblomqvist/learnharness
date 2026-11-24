"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { appendFilePathText, useFileDropTarget } from "@/components/file-drop-target";
import { composingQuestionKey, pluginQuestionKeySuppressed } from "./plugin-question-keys";
import { PathInput } from "@/components/path-input";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the check answer as the SEPARATE `readingThinking`
 * channel (never conflated with the quiz thinking), and disappears with
 * the question.
 */
export function ReadingThinkingField({
	value,
	revision,
	onChange,
	onOpen,
	primaryDropTarget,
	inputRef,
}: {
	value: string;
	revision: number;
	onChange: (v: string) => void;
	/** Enter opens the check while it waits behind its reveal. */
	onOpen?: () => void;
	primaryDropTarget: boolean;
	inputRef?: RefObject<HTMLDivElement | null>;
}) {
	const controller = useOptionalInteractionLayers();
	const [draft, setDraft] = useState(value);
	// Appends may arrive back-to-back before React commits. Like Chat's
	// submit mirror, this ref includes every edit synchronously.
	const draftRef = useRef(value);
	useLayoutEffect(() => { draftRef.current = value; setDraft(value); }, [revision, value]);
	const applyDraft = useCallback((next: string) => {
		draftRef.current = next;
		setDraft(next);
		onChange(next);
	}, [onChange]);
	useFileDropTarget((paths) => applyDraft(appendFilePathText(draftRef.current, paths)), { enabled: primaryDropTarget });
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-2xl border bg-card/60 px-3 py-2 transition-colors focus-within:border-primary/50"
		>
			<div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Thinking while reading
			</div>
			<PathInput
				ref={inputRef}
				value={draft}
				onValueChange={applyDraft}
				/* py-0.5 (owner round, 2026-10-07): the scrollbar fix. Source
				   Sans 3's font box is 22px at 16px; lh-input's 1.25 leading
				   gives a 20px line box — the content area sticks 1px below the
				   line, Chromium counts it in scrollHeight, and a zero-padding
				   textarea turns that into a permanent 1px scroll (the bar shows
				   empty and at every size below max-h). 2px of vertical padding
				   absorbs it — the same absorption the composer and dock fields
				   get implicitly from their py-2. Line-height stays 1.25 (the
				   caret law, typography round 2). */
				onKeyDown={(e) => {
					if (composingQuestionKey(e) || pluginQuestionKeySuppressed(e)) return;
					if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
					if (e.key === "Escape") {
						controller?.claimEscape(e);
						e.preventDefault();
						e.stopPropagation();
						return;
					}
					// Shift+Enter stays a newline.
					if (e.key === "Enter" && onOpen !== undefined && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.stopPropagation();
						onOpen();
						return;
					}
					// The dock's dumping convention: plain Enter is a newline.
					// No submit button here — the check's own submit is this
					// field's carrier — so ⌘↵ just blurs.
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.currentTarget.blur();
					}
				}}
				placeholder="Whatever comes to mind as you read."
				className="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 outline-none placeholder:text-muted-foreground/70"
			/>
		</div>
	);
}

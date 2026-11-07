"use client";

import { useEffect, useRef } from "react";
import { serializeCitation, withCitationComment } from "@/src/core";
import { MenuShell } from "./menu-shell";
import { CitationCommentEditor, commentDismissalOutcome, type CommentDismissal } from "./citation-comment-editor";
import type { CitationEditTarget } from "./citation-actions";
import { highlightRange } from "./citation-source";
import { PATH_SOURCE_ATTRIBUTE } from "./path-input-dom";
import { UPDATE_CITATION_EVENT, type UpdateCitationDetail } from "./path-input";
import { resolveCitationRange } from "./selection-text";

/** The comment popover for one composer citation: anchored to the cited
 *  tutor text (highlighted while open), else to the chip. */
export function CitationCommentPopover({ target, transcript, composer, onClose, onSend }: {
	target: CitationEditTarget;
	transcript: HTMLElement | null;
	composer: () => HTMLElement | null;
	onClose: () => void;
	/** Save-and-send: the composer's own send, run after the link updates. */
	onSend: () => void;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const draftRef = useRef<string | null>(null);
	const { citation } = target;

	const sourceRange = () => (transcript ? resolveCitationRange(transcript, citation.messageId, citation) : null);
	const chipHost = () => target.host?.isConnected ? target.host
		: Array.from(composer()?.querySelectorAll<HTMLElement>(`[${PATH_SOURCE_ATTRIBUTE}]`) ?? []).find((host) => host.getAttribute(PATH_SOURCE_ATTRIBUTE) === target.link) ?? null;

	const update = (source: string | null) => {
		const root = composer();
		if (!root) return;
		const detail: UpdateCitationDetail = {
			start: target.start,
			end: target.start + target.link.length,
			previous: target.link,
			source,
			...(source === null && target.fresh ? { spaceBefore: target.fresh.spaceBefore, spaceAfter: target.fresh.spaceAfter } : {}),
		};
		const View = root.ownerDocument.defaultView;
		root.dispatchEvent(new (View?.CustomEvent ?? CustomEvent)(UPDATE_CITATION_EVENT, { detail }));
	};
	const save = (comment: string, andSend: boolean) => {
		const next = serializeCitation(withCitationComment(citation, comment));
		if (next !== target.link) update(next);
		onClose();
		if (andSend) onSend();
	};
	const cancel = () => {
		if (target.fresh) update(null); // a just-cited chip leaves with its spaces
		onClose();
	};
	const dismiss = (reason: CommentDismissal) => {
		const outcome = commentDismissalOutcome({ reason, draft: draftRef.current, saved: citation.comment });
		if (outcome === "keep-open") return;
		if (outcome === "commit") save(draftRef.current!, false);
		else if (reason === "escape") cancel();
		else onClose();
	};
	const dismissRef = useRef(dismiss);
	dismissRef.current = dismiss;

	// The cited words stay highlighted while the comment is being written.
	useEffect(() => {
		const range = sourceRange();
		return range ? highlightRange("lh-citation-comment", range) : undefined;
	}, [transcript, target]);

	useEffect(() => {
		const inside = (node: EventTarget | null) => node instanceof Node && !!rootRef.current?.contains(node);
		const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) dismissRef.current("outside"); };
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Claim Esc: the window-level chain must not also abort a turn.
			event.stopPropagation();
			dismissRef.current("escape");
		};
		const onFocusOut = (event: FocusEvent) => { if (event.relatedTarget && !inside(event.relatedTarget)) dismissRef.current("focus-out"); };
		const root = rootRef.current;
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		root?.addEventListener("focusout", onFocusOut);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			root?.removeEventListener("focusout", onFocusOut);
		};
	}, []);

	const getAnchorRect = () => {
		const lines = sourceRange()?.getClientRects();
		const last = lines && lines.length > 0 ? lines[lines.length - 1]! : null;
		return last ?? chipHost()?.getBoundingClientRect() ?? null;
	};

	return (
		<MenuShell testid="citation-comment-popover" getAnchorRect={getAnchorRect} preferredSide="down" align="right" menuClass="w-80 rounded-xl border bg-popover p-2 text-sm shadow-xl">
			<div ref={rootRef} role="dialog" aria-label="Edit citation comment">
				<CitationCommentEditor
					initial={citation.comment}
					onDraftChange={(draft) => { draftRef.current = draft; }}
					onSave={save}
					onCancel={cancel}
				/>
			</div>
		</MenuShell>
	);
}

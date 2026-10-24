"use client";

import { useEffect } from "react";
import { XIcon } from "lucide-react";

/**
 * THE IMAGE FOCUS (composer image paste): clicking a pasted image — the
 * draft thumbnail in the composer, or the sent picture in the transcript —
 * opens it at its natural size over the session area.
 *
 * Same shell law as MermaidOverlay (session-overlay.tsx): the overlay mounts
 * ABSOLUTE inside the session area (never `fixed inset-0`), so the 60px drag
 * bar stays sharp and draggable and the X never lands in drag territory.
 * The chat page owns the open state; this overlay claims its own Esc at the
 * document level (the same ONE-ESC law as MermaidOverlay: the dictation and
 * abort chains never fire under a surfaced layer).
 */
export function ImageLightbox({
	url,
	alt,
	onClose,
}: {
	url: string;
	alt: string;
	onClose: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div
			data-testid="image-lightbox"
			className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
			onClick={onClose}
		>
			<button
				type="button"
				aria-label="Close image"
				onClick={onClose}
				className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-lg border bg-card text-muted-foreground transition-colors hover:text-foreground"
			>
				<XIcon className="size-4" />
			</button>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img
				src={url}
				alt={alt}
				// The click is the backdrop's close — the picture itself must not
				// swallow it (a full-bleed image would otherwise be a dead zone).
				onClick={(e) => e.stopPropagation()}
				className="max-h-full max-w-full rounded-lg border bg-card object-contain shadow-lg"
			/>
		</div>
	);
}

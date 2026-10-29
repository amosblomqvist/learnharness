"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useEscapeClaim } from "@/components/escape-claim";
import { XIcon } from "lucide-react";

/**
 * THE IMAGE FOCUS (composer image paste): clicking a pasted image (the
 * draft thumbnail in the composer, or the sent picture in the transcript)
 * opens it at its natural size over the session area.
 *
 * Same shell law as MermaidOverlay (session-overlay.tsx): the overlay mounts
 * ABSOLUTE inside the session area (never `fixed inset-0`), so the 60px drag
 * bar stays sharp and draggable and the X never lands in drag territory.
 * The surface owns the open state (useImageLightbox below); the overlay
 * claims its own Esc (useEscapeClaim, the one-Esc law).
 */
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
	useEscapeClaim(onClose);
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
				alt="Pasted from the clipboard"
				// Only the backdrop and the X close: a click on the picture itself
				// keeps it open.
				onClick={(e) => e.stopPropagation()}
				className="max-h-full max-w-full rounded-lg border bg-card object-contain shadow-lg"
			/>
		</div>
	);
}

/**
 * The open state + mount every surface shares: `open(url)` shows the
 * picture, and `lightbox` is the node to render inside the surface's
 * relative session area (null while closed).
 */
export function useImageLightbox(): { open: (url: string) => void; lightbox: ReactNode } {
	const [url, setUrl] = useState<string | null>(null);
	const close = useCallback(() => setUrl(null), []);
	return {
		open: setUrl,
		lightbox: url === null ? null : <ImageLightbox url={url} onClose={close} />,
	};
}

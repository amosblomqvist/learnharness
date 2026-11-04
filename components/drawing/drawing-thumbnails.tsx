"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import type { DrawingRef } from "@/src/core";
import { cn } from "@/lib/utils";
import { useImageSnapshot } from "@/components/artifacts/use-image-snapshot";
import { LOCAL_DRAWING_PREFIX, localDrawingImage } from "@/components/drawing/pad-state";

/**
 * The learner's sent drawings in the transcript (2026-11-04): small
 * thumbnails; a click opens the drawing full size, read-only. Saved refs
 * fetch the session snapshot; optimistic (local-) refs resolve from the
 * pad's local registry until the record copy is adopted.
 */
export function DrawingThumbnails({ drawings, className }: { drawings: readonly DrawingRef[]; className?: string }) {
	// The lightbox reuses the thumbnail's loaded image — no second fetch.
	const [open, setOpen] = useState<{ index: number; src: string } | null>(null);
	if (drawings.length === 0) return null;
	return (
		<div data-testid="drawing-thumbnails" className={cn("flex flex-wrap gap-1.5", className)}>
			{drawings.map((d, i) => (
				<DrawingThumb key={`${d.snapshotId}-${i}`} drawing={d} index={i} onOpen={(src) => setOpen({ index: i, src })} />
			))}
			{open !== null && <DrawingLightbox src={open.src} index={open.index} onClose={() => setOpen(null)} />}
		</div>
	);
}

function DrawingThumb({ drawing, index, onOpen }: { drawing: DrawingRef; index: number; onOpen: (src: string) => void }) {
	const src = useDrawingSrc(drawing);
	return (
		<button
			type="button"
			aria-label={`Open drawing ${index + 1}`}
			disabled={!src}
			onClick={() => src && onOpen(src)}
			className="block h-16 w-24 overflow-hidden rounded-md border border-border bg-white transition-colors hover:border-primary/60"
		>
			{src ? (
				// eslint-disable-next-line @next/next/no-img-element -- a session snapshot data URL, not an optimizable asset
				<img src={src} alt={`Drawing ${index + 1}`} className="size-full object-contain" />
			) : (
				<span aria-label={`Drawing ${index + 1}`} className="block size-full bg-muted" />
			)}
		</button>
	);
}

function useDrawingSrc(drawing: DrawingRef): string | undefined {
	const local = drawing.snapshotId.startsWith(LOCAL_DRAWING_PREFIX) ? localDrawingImage(drawing.snapshotId) : undefined;
	const { image } = useImageSnapshot(local || drawing.snapshotId.startsWith(LOCAL_DRAWING_PREFIX) ? undefined : drawing.snapshotId);
	if (local) return `data:image/png;base64,${local.png}`;
	return image ? `data:${image.mimeType};base64,${image.data}` : undefined;
}

function DrawingLightbox({ src, index, onClose }: { src: string; index: number; onClose: () => void }) {
	// Esc closes — claimed at the document level (the ONE-ESC LAW).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label={`Drawing ${index + 1}`}
			data-testid="drawing-lightbox"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
		>
			<div className="relative max-h-full max-w-full overflow-auto rounded-lg bg-white shadow-xl">
				{/* eslint-disable-next-line @next/next/no-img-element -- a session snapshot data URL, not an optimizable asset */}
				<img src={src} alt={`Drawing ${index + 1}`} className="block h-auto max-h-[85vh] w-auto max-w-[90vw]" />
				<button
					type="button"
					aria-label="Close drawing"
					onClick={onClose}
					className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
				>
					<XIcon className="size-4" />
				</button>
			</div>
		</div>,
		document.body,
	);
}

"use client";

import { imageFileName, imageUrl, isRasterDataUrl } from "@/src/core";
import { useSessionMermaid } from "@/components/session-overlay";

/** Raster thumbnails shared by learner messages and tool results. */
export interface GalleryItem {
	/** A raster data: URL (anything else is dropped). */
	url: string;
	alt?: string;
	caption?: string;
}

/** Native image blocks to gallery items; blocks with an unknown MIME or a
 *  malformed payload are skipped. Never throws on foreign shapes. */
export function galleryItemsFromBlocks(blocks: unknown, caption?: string): GalleryItem[] {
	if (!Array.isArray(blocks)) return [];
	const items: GalleryItem[] = [];
	for (const b of blocks) {
		const v = (b ?? {}) as Record<string, unknown>;
		if (v.type !== "image" || typeof v.mimeType !== "string" || typeof v.data !== "string") continue;
		const url = imageUrl({ type: "image", mimeType: v.mimeType, data: v.data });
		if (isRasterDataUrl(url)) items.push({ url, caption });
	}
	return items;
}

function Thumb({ item, onOpen }: { item: GalleryItem; onOpen?: (url: string) => void }) {
	const alt = item.alt ?? item.caption ?? "Image";
	if (!onOpen) {
		// No shared lightbox here: thumbnail plus a download link only (no
		// overlay is mounted inside a scroller).
		return (
			<span className="my-1 inline-flex w-fit max-w-full flex-col items-start gap-0.5">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={item.url} alt={alt} data-testid="user-image" className="max-h-64 w-auto max-w-full rounded-[6px] border" />
				<a href={item.url} download={imageFileName(item.url)} className="text-xs text-muted-foreground underline">
					Download
				</a>
			</span>
		);
	}
	return (
		<button
			type="button"
			data-testid="user-image"
			onClick={() => onOpen(item.url)}
			aria-label="View image in full"
			title={item.caption}
			className="my-1 block w-fit max-w-full cursor-zoom-in"
		>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={item.url} alt={alt} className="max-h-64 w-auto max-w-full rounded-[6px] border" />
		</button>
	);
}

export function ImageGallery({
	items,
	onOpenImage,
	inline = false,
	showCaptions = false,
}: {
	items: readonly GalleryItem[];
	/** Overrides the shared opener (useSessionMermaid().openImage). */
	onOpenImage?: (url: string) => void;
	/** Render the thumbnails as bare siblings (no wrapper), for transcript rows. */
	inline?: boolean;
	showCaptions?: boolean;
}) {
	const shared = useSessionMermaid()?.openImage;
	const open = onOpenImage ?? shared;
	const safe = items.filter((i) => isRasterDataUrl(i.url));
	if (safe.length === 0) return null;
	const thumbs = safe.map((item, i) =>
		showCaptions && item.caption ? (
			<figure key={i} className="m-0 w-fit max-w-full">
				<Thumb item={item} onOpen={open} />
				<figcaption className="truncate text-xs text-muted-foreground">{item.caption}</figcaption>
			</figure>
		) : (
			<Thumb key={i} item={item} onOpen={open} />
		),
	);
	if (inline) return thumbs;
	return (
		<div data-testid="image-gallery" className="my-1 flex flex-wrap items-start gap-2">
			{thumbs}
		</div>
	);
}

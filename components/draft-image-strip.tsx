"use client";

import { XIcon } from "lucide-react";
import { imageUrl } from "@/src/core";
import type { ImageDraftProps } from "@/components/draft-images";

/**
 * THE DRAFT STRIP (composer paste): what the send will carry. Thumbnails
 * with a cross at the TOP-RIGHT to remove one, click to open full size, and
 * the one-line refusal. A full-width row above the input (the composer
 * row wraps), never inside it: the textarea stays a text field.
 *
 * Shared by every sending surface (the session composer, home, the /chat/new
 * draft) so the affordance is identical wherever a learner starts.
 */
export function DraftImageStrip({ draft }: { draft: ImageDraftProps }) {
	const { images, error, onChange, onOpen } = draft;
	if (images.length === 0 && !error) return null;
	return (
		<div data-testid="composer-images" className="flex w-full flex-wrap items-center gap-1.5 px-0.5">
			{images.map((img) => (
				<div key={img.id} className="relative">
					{/* Click = full size; the cross at the top-right is the remove.
					    Both are real buttons, so the keyboard reaches them in order. */}
					<button
						type="button"
						aria-label="View pasted image in full"
						onClick={() => onOpen?.(imageUrl(img))}
						className="block cursor-zoom-in"
					>
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img
							src={imageUrl(img)}
							alt="Pasted from the clipboard"
							className="size-16 rounded-[10px] border bg-muted object-cover"
						/>
					</button>
					<button
						type="button"
						aria-label="Remove image"
						onClick={() => onChange(images.filter((i) => i.id !== img.id))}
						className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground"
					>
						<XIcon className="size-3" />
					</button>
				</div>
			))}
			{error && <p className="font-ui text-xs text-destructive">{error}</p>}
		</div>
	);
}

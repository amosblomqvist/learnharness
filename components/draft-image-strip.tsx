"use client";

import { XIcon } from "lucide-react";
import { imageUrl, type DraftImage } from "@/src/core";

/**
 * THE DRAFT STRIP (composer paste): what the send will carry. Thumbnails
 * with a cross at the TOP-RIGHT to remove one, click to open full size, and
 * the one-line refusal. Rows above the input, never inside it — the
 * textarea stays a text field.
 *
 * Shared by every sending surface (the session composer, home, the /chat/new
 * draft) so the affordance is identical wherever a learner starts.
 */
export function DraftImageStrip({
	images,
	error = null,
	onRemove,
	onOpen,
}: {
	images: readonly DraftImage[];
	error?: string | null;
	onRemove: (id: string) => void;
	onOpen?: (image: DraftImage) => void;
}) {
	if (images.length === 0 && !error) return null;
	return (
		<div data-testid="composer-images" className="flex flex-wrap items-center gap-1.5 px-0.5">
			{images.map((img) => (
				<div key={img.id} className="relative">
					{/* Click = full size; the cross at the top-right is the remove.
					    Both are real buttons, so the keyboard reaches them in order. */}
					<button
						type="button"
						aria-label="View pasted image in full"
						onClick={() => onOpen?.(img)}
						className="block cursor-zoom-in"
					>
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img
							src={imageUrl(img)}
							alt="Pasted image"
							className="size-16 rounded-[10px] border bg-muted object-cover"
						/>
					</button>
					<button
						type="button"
						aria-label="Remove image"
						onClick={() => onRemove(img.id)}
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

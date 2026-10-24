"use client";

import type { LhViewPart } from "@/src/core";

/**
 * The body of a learner's transcript row: text and pasted pictures in the
 * order the learner sent them (core/view.ts keeps that order). Text renders
 * plain, never through the model's LaTeX pipeline ($ stays $). A picture
 * opens full size on click.
 */
export function UserMessageParts({
	parts,
	onOpenImage,
}: {
	parts: readonly LhViewPart[];
	onOpenImage: (url: string) => void;
}) {
	return parts.map((part) => {
		const key = part.id;
		if (part.type === "text") {
			return (
				<div key={key} className="lh-prose whitespace-pre-wrap text-foreground">
					{part.text}
				</div>
			);
		}
		if (part.type !== "image") return null;
		const url = String(part.url);
		return (
			<button
				key={key}
				type="button"
				data-testid="user-image"
				onClick={() => onOpenImage(url)}
				aria-label="View pasted image in full"
				className="my-1 block w-fit cursor-zoom-in"
			>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={url} alt={String(part.alt)} className="max-h-64 w-auto rounded-[6px] border" />
			</button>
		);
	});
}

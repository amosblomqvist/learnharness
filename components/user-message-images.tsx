"use client";

import type { UserImageAttachment } from "@/src/core";
import { useImageSnapshot } from "@/components/artifacts/use-image-snapshot";

/**
 * The sent user message's pictures (issue #96): the refs the input carried,
 * resolved through the session's snapshot store — the same read the image
 * cards use (GET /api/chats/:id/images/:snapshotId), so a persisted
 * conversation renders its thumbnails on reload identically.
 */

function UserImageThumb({ image }: { image: UserImageAttachment }) {
	const { image: snapshot, failed } = useImageSnapshot(image.snapshotId);
	if (!snapshot) {
		return (
			<span className="text-muted-foreground" role="status" data-testid="user-image-pending">
				{failed ? `${image.name} (image unavailable)` : `Loading ${image.name}…`}
			</span>
		);
	}
	return (
		// An in-memory image from the record; no Next image optimization.
		// eslint-disable-next-line @next/next/no-img-element
		<img
			src={`data:${snapshot.mimeType};base64,${snapshot.data}`}
			alt={image.name}
			width={snapshot.width}
			height={snapshot.height}
			className="h-auto max-h-48 w-auto max-w-full rounded-md border"
			draggable={false}
			data-testid="user-image"
		/>
	);
}

/** The bubble's thumbnail strip: the pictures under the learner's text. */
export function UserMessageImages({ images }: { images: readonly UserImageAttachment[] }) {
	return (
		<div className="mt-1.5 flex flex-wrap items-start gap-2" data-testid="user-images">
			{images.map((image) => (
				<UserImageThumb key={image.snapshotId} image={image} />
			))}
		</div>
	);
}

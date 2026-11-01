"use client";

import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import type { ArtifactPartProps, ShowImageDetails } from "@/src/core";

/**
 * The show_image card (issue #363): one of the learner's own images, as
 * document material like a figure — the picture, then a caption row with
 * "Image" + the teacher's caption left and the controls right. No invert
 * switch (owner decision: a photo inverts to a negative). A failed or
 * still-running call keeps the quiet tool-call card.
 */

function isShowImageDetails(value: unknown): value is ShowImageDetails {
	const v = value as Partial<ShowImageDetails> | null | undefined;
	return (
		typeof v?.data === "string" &&
		v.data.length > 0 &&
		(v.mimeType === "image/png" || v.mimeType === "image/jpeg") &&
		typeof v.path === "string" &&
		typeof v.width === "number" &&
		typeof v.height === "number"
	);
}

/** The learner's file name, without its directory. Pure. */
function baseName(path: string): string {
	return path.split(/[\\/]/).pop() || "image";
}

/** The download name: the file's stem with the STORED format's extension
 *  (a converted or shrunk image is no longer the original bytes). Pure. */
export function imageDownloadName(image: Pick<ShowImageDetails, "path" | "mimeType">): string {
	const stem = baseName(image.path).replace(/\.[^.]*$/, "") || "image";
	return `${stem}.${image.mimeType === "image/png" ? "png" : "jpg"}`;
}

/** The image as a standalone SVG document — the shape the fullscreen
 *  overlay (an SVG viewer, sized by viewBox) takes. Pure. */
export function imageSvgDocument(image: Pick<ShowImageDetails, "mimeType" | "data" | "width" | "height">): string {
	const { width, height } = image;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:${image.mimeType};base64,${image.data}" width="${width}" height="${height}"/></svg>`;
}

export function ImageCard({ part }: ArtifactPartProps) {
	const overlay = useSessionMermaid();
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	const image = part.output;
	if (!isShowImageDetails(image)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Image shown, but it could not be displayed.
			</div>
		);
	}
	const save = () => {
		const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
		downloadFile(imageDownloadName(image), bytes, image.mimeType);
	};
	return (
		/* The figure card's sizing law: the wrapper hugs the picture's natural
		   width (max-w-full shrinks a wide one), and the caption row follows
		   it — w-0 + min-w-full keeps a long caption from widening the card. */
		<figure className="my-4 mx-auto w-fit max-w-full" data-testid="image-card">
			<div className="w-fit max-w-full overflow-hidden rounded-lg">
				{/* An in-memory image from the record; no Next image optimization. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={`data:${image.mimeType};base64,${image.data}`}
					alt={image.caption ?? baseName(image.path)}
					width={image.width}
					height={image.height}
					className="block h-auto max-w-full"
					draggable={false}
				/>
			</div>
			<figcaption className="mt-2 flex w-0 min-w-full items-start justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Image</span>
					{image.caption && (
						<span className="text-sm text-muted-foreground" data-testid="image-caption">
							{image.caption}
						</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						aria-label="Download image"
						title="Download image"
						onClick={save}
						data-testid="image-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open image fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openFigure(imageSvgDocument(image), false)}
							data-testid="image-open"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</figcaption>
		</figure>
	);
}

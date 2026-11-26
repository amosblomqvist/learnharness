"use client";

import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import type { ArtifactPartProps, ImageSnapshot, ShowImageDetails, WebImageDetails } from "@/src/core";
import { useImageSnapshot } from "./use-image-snapshot";

/**
 * The show_image card (issue #363): one of the learner's own images, as
 * document material like a figure — the picture, then a caption row with
 * "Image" + the teacher's caption left and the controls right. No invert
 * switch (owner decision: a photo inverts to a negative). A failed or
 * still-running call keeps the quiet tool-call card. A Wikimedia Commons
 * picture (show_image with `commons`) adds the attribution line its free
 * license asks for: title, author and license, linked to Commons.
 */

function isShowImageDetails(value: unknown): value is ShowImageDetails {
	const v = value as Partial<ShowImageDetails> | null | undefined;
	return (
		typeof v?.snapshotId === "string" &&
		/^[a-f0-9]{64}$/.test(v.snapshotId) &&
		(v.mimeType === "image/png" || v.mimeType === "image/jpeg") &&
		typeof v.path === "string" &&
		typeof v.width === "number" &&
		typeof v.height === "number"
	);
}

export function isWebImageDetails(value: unknown): value is WebImageDetails {
	const v = value as Partial<WebImageDetails> | null | undefined;
	return (
		v?.source === "commons" &&
		typeof v.snapshotId === "string" &&
		/^[a-f0-9]{64}$/.test(v.snapshotId) &&
		(v.mimeType === "image/png" || v.mimeType === "image/jpeg") &&
		typeof v.title === "string" &&
		typeof v.pageUrl === "string" &&
		typeof v.width === "number" &&
		typeof v.height === "number"
	);
}

/** Commons attribution for the caption row; links only to http(s). */
export interface ImageAttribution {
	title: string;
	pageUrl: string;
	author?: string;
	license?: string;
	licenseUrl?: string;
}

const httpUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);

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
export function imageSvgDocument(image: ImageSnapshot): string {
	const { width, height } = image;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:${image.mimeType};base64,${image.data}" width="${width}" height="${height}"/></svg>`;
}

export function ImageCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	const image = part.output;
	if (isWebImageDetails(image)) return <StoredWebImageCard details={image} />;
	if (!isShowImageDetails(image)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Image shown, but it could not be displayed.
			</div>
		);
	}
	return <StoredImageCard details={image} />;
}

function StoredImageCard({ details }: { details: ShowImageDetails }) {
	const { image, failed } = useImageSnapshot(details.snapshotId);
	if (!image) return <div className="my-4 text-sm text-muted-foreground" role="status">{failed ? "Image snapshot could not be loaded." : "Loading image…"}</div>;
	return <ImagePresentation image={{ ...image, path: details.path, caption: details.caption }} />;
}

function StoredWebImageCard({ details }: { details: WebImageDetails }) {
	const { image, failed } = useImageSnapshot(details.snapshotId);
	if (!image) return <div className="my-4 text-sm text-muted-foreground" role="status">{failed ? "Image snapshot could not be loaded." : "Loading image…"}</div>;
	const name = details.title.replace(/^file:/i, "");
	const { title, pageUrl, author, license, licenseUrl } = details;
	return <ImagePresentation image={{ ...image, path: name, caption: details.caption }} attribution={{ title, pageUrl, author, license, licenseUrl }} />;
}

/** Resolved presentation shared by inline display, download and fullscreen. */
export function ImagePresentation({ image, attribution }: { image: ImageSnapshot & Pick<ShowImageDetails, "path" | "caption">; attribution?: ImageAttribution }) {
	const overlay = useSessionMermaid();
	const save = () => {
		const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
		downloadFile(imageDownloadName(image), bytes, image.mimeType);
	};
	return (
		/* Auto dimensions let the width/60vh constraints scale the whole picture
		   proportionally, never enlarge it. The wrapper hugs its displayed width;
		   w-0 + min-w-full keeps the caption from widening the card. */
		<figure className="my-4 mx-auto w-fit max-w-full" data-testid="image-card">
			<div className="w-fit max-w-full overflow-hidden rounded-lg">
				{/* An in-memory image from the record; no Next image optimization. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={`data:${image.mimeType};base64,${image.data}`}
					alt={image.caption ?? baseName(image.path)}
					width={image.width}
					height={image.height}
					className="block h-auto w-auto max-h-[60vh] max-w-full"
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
			{attribution && <Attribution {...attribution} />}
		</figure>
	);
}

function Attribution({ title, pageUrl, author, license, licenseUrl }: ImageAttribution) {
	const page = httpUrl(pageUrl);
	const licenseLink = httpUrl(licenseUrl);
	const name = title.replace(/^file:/i, "");
	return (
		<p className="mt-1 w-0 min-w-full text-xs text-muted-foreground" data-testid="image-attribution">
			{page ? <a href={page} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{name}</a> : name}
			{author && <> by {author}</>}
			{license && <>, {licenseLink ? <a href={licenseLink} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{license}</a> : license}</>}
			{", via Wikimedia Commons"}
		</p>
	);
}

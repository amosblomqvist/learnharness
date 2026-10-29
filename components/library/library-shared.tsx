"use client";

import { FileTextIcon, FolderIcon, FolderOpenIcon, ImageIcon, LoaderCircleIcon, PresentationIcon, TriangleAlertIcon } from "lucide-react";
import { LIBRARY_TAG_LABELS, type LibraryFileFormat, type LibraryFileMeta, type LibraryItem, type LibrarySummaryState, type LibraryTag } from "@/src/core";

/** Pure presentation shared by the library page, the picker, and the
 *  Materials panel (exported for render pins). */

export function ItemGlyph({ item, open = false, className = "size-4" }: { item: Pick<LibraryItem, "kind" | "file">; open?: boolean; className?: string }) {
	if (item.kind === "folder") {
		const Icon = open ? FolderOpenIcon : FolderIcon;
		return <Icon aria-hidden="true" className={`${className} shrink-0 text-muted-foreground`} />;
	}
	return <FormatGlyph format={item.file?.format ?? "pdf"} className={className} />;
}

export function FormatGlyph({ format, className = "size-4" }: { format: LibraryFileFormat; className?: string }) {
	const Icon = format === "pptx" ? PresentationIcon : format === "image" ? ImageIcon : FileTextIcon;
	return <Icon aria-hidden="true" className={`${className} shrink-0 text-muted-foreground`} />;
}

/** A tag chip. `inherited` renders it quieter (dashed) — the effective
 *  tag comes from a folder above, not the item itself. */
export function TagBadge({ tag, inherited = false }: { tag: LibraryTag; inherited?: boolean }) {
	return (
		<span
			data-testid="library-tag"
			data-inherited={inherited ? "true" : undefined}
			title={inherited ? "Inherited from a folder above" : undefined}
			className={
				"shrink-0 rounded-full border px-2 py-0.5 font-ui text-[10px] uppercase tracking-wider " +
				(inherited ? "border-dashed border-border/70 text-muted-foreground/80" : "border-border text-foreground")
			}
		>
			{LIBRARY_TAG_LABELS[tag]}
		</span>
	);
}

/** Import + summary status for a file, or nothing when all is quiet. */
export function FileStatus({ status, error, summary }: { status: LibraryFileMeta["status"]; error?: string; summary?: LibrarySummaryState }) {
	if (status === "processing") {
		return (
			<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
				<LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin" />
				Importing
			</span>
		);
	}
	if (status === "failed") {
		return (
			<span title={error} className="flex shrink-0 items-center gap-1 text-[11px] text-destructive">
				<TriangleAlertIcon aria-hidden="true" className="size-3" />
				Import failed
			</span>
		);
	}
	if (summary === "pending") {
		return (
			<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
				<LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin" />
				Summarizing
			</span>
		);
	}
	if (summary === "failed") {
		return (
			<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" title="Re-attach the file to retry">
				<TriangleAlertIcon aria-hidden="true" className="size-3" />
				No summary
			</span>
		);
	}
	return null;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "12 pages" / "8 slides" / "4 sections" / "Image" for a file row. */
export function unitsText(item: Pick<LibraryItem, "file">): string {
	const file = item.file;
	if (!file) return "";
	if (file.format === "image") return "Image";
	if (file.pages === undefined) return file.format.toUpperCase();
	const unit = file.format === "pptx" ? "slide" : file.via === "extracted" ? "section" : "page";
	return `${file.pages} ${unit}${file.pages === 1 ? "" : "s"}`;
}

/** The file-input accept list (the server's allow-list mirrored). */
export const LIBRARY_ACCEPT = ".pdf,.docx,.pptx,.jpg,.jpeg,.png,.gif,.webp";

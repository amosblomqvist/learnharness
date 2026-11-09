"use client";

import { useRef } from "react";
import { ImageIcon, XIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useImageSnapshot } from "@/components/artifacts/use-image-snapshot";

/**
 * The composer's attached images (issue #96): paste or pick a picture, it
 * uploads through POST /api/chats/:id/images into the session's snapshot
 * store, and the chip holds the returned REF until the send attaches it to
 * the text input. Pure helpers live here so the static-render/linkedom
 * harness can pin them without a clipboard.
 */

/** The composer's per-image draft state. UPLOADING until the upload route
 *  answers; FAILED chips explain and stay removable (they never block the
 *  send of the rest — only their own picture is dropped). The uploaded
 *  state carries only the REF — the thumbnail resolves through the
 *  session's snapshot store, like every stored picture. */
export interface ComposerImage {
	/** Local identity (the remove button's target). */
	key: string;
	/** The original file name (paste or picker). */
	name: string;
	state:
		| { phase: "uploading" }
		| { phase: "uploaded"; snapshotId: string }
		| { phase: "failed"; error: string };
}

/** A draft can send when at least one picture is stored and none is still
 *  uploading (a send is never blocked forever by a failed chip — that chip
 *  is simply excluded). Pure. */
export function composerImagesSendable(images: readonly ComposerImage[]): boolean {
	return images.some((image) => image.state.phase === "uploaded")
		&& !images.some((image) => image.state.phase === "uploading");
}

/** The files worth uploading from a paste event's clipboard. Prefers the
 *  item list (screenshot tools register kind "file" items with the OS
 *  type); falls back to the FileList for environments that only fill it.
 *  Pure; never reads file contents. */
export function pastedImageFiles(clipboard: { items?: Iterable<{ kind?: string; type?: string; getAsFile?: () => File | null }>; files?: Iterable<File> } | null): File[] {
	if (!clipboard) return [];
	const out: File[] = [];
	for (const item of clipboard.items ?? []) {
		if (item.kind !== "file" || !item.type?.startsWith("image/")) continue;
		const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
		if (file) out.push(file);
	}
	if (out.length > 0) return out;
	for (const file of clipboard.files ?? []) {
		if (file.type.startsWith("image/")) out.push(file);
	}
	return out;
}

/** One chip: thumbnail (the stored snapshot, like the transcript card),
 * name, and remove. Uploads show the spinner; failures show their reason. */
function ComposerImageChip({ image, onRemove }: { image: ComposerImage; onRemove: (key: string) => void }) {
	const { image: snapshot, failed } = useImageSnapshot(image.state.phase === "uploaded" ? image.state.snapshotId : undefined);
	return (
		<span
			data-testid="composer-image-chip"
			className="inline-flex max-w-full items-center gap-1.5 rounded border bg-muted/50 py-0.5 pl-0.5 pr-1 align-middle text-sm"
		>
			{image.state.phase === "uploading" ? (
				<span className="flex size-8 shrink-0 items-center justify-center" role="status" aria-label={`Uploading ${image.name}`}>
					<BrailleSpinner className="size-4 text-muted-foreground" />
				</span>
			) : image.state.phase === "failed" ? (
				<span className="flex size-8 shrink-0 items-center justify-center text-destructive" aria-label={`Failed: ${image.name}`}>
					<ImageIcon className="size-4" aria-hidden />
				</span>
			) : snapshot ? (
				// An in-memory image from the record; no Next image optimization.
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={`data:${snapshot.mimeType};base64,${snapshot.data}`}
					alt={image.name}
					className="size-8 shrink-0 rounded-sm object-cover"
					draggable={false}
				/>
			) : (
				<span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground" role="status">
					{failed ? <ImageIcon className="size-4" aria-hidden /> : <BrailleSpinner className="size-4" />}
				</span>
			)}
			<span className="min-w-0 max-w-48 truncate" title={image.state.phase === "failed" ? `${image.name}: ${image.state.error}` : image.name}>
				{image.state.phase === "failed" ? <span className="text-destructive">{image.name}</span> : image.name}
			</span>
			<button
				type="button"
				aria-label={`Remove image ${image.name}`}
				data-testid="composer-image-remove"
				onClick={() => onRemove(image.key)}
				className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<XIcon className="size-3" aria-hidden />
			</button>
		</span>
	);
}

/** The chips row above the composer's content row (issue #96): one
 *  removable chip per attached picture, the visual twin of the quoted path
 *  chips inside the draft text. */
export function ComposerImageChips({ images, onRemove }: { images: readonly ComposerImage[]; onRemove: (key: string) => void }) {
	if (images.length === 0) return null;
	return (
		<div data-testid="composer-image-chips" className="flex flex-wrap gap-1.5 px-1 pt-1">
			{images.map((image) => (
				<ComposerImageChip key={image.key} image={image} onRemove={onRemove} />
			))}
		</div>
	);
}

/** The explicit picker (issue #96): unlike path attachments, image bytes
 *  upload from any environment — the browser included — so the button is
 *  always available. Multiple selection; the upload flow runs per file. */
export function AttachImageButton({ onFiles }: { onFiles: (files: File[]) => void }) {
	const pickerRef = useRef<HTMLInputElement>(null);
	return (
		<div className="relative shrink-0">
			<input
				ref={pickerRef}
				type="file"
				// The shared pipeline's supported inputs (jpg, png, gif, webp, bmp).
				accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
				multiple
				hidden
				data-testid="attach-image-input"
				onChange={(e) => {
					const files = Array.from(e.currentTarget.files ?? []).filter((file) => file.type.startsWith("image/"));
					if (files.length > 0) onFiles(files);
					e.currentTarget.value = ""; // allow re-picking the same file
				}}
			/>
			<Hint label="Attach an image">
				<button
					type="button"
					aria-label="Attach image"
					data-testid="attach-image"
					onClick={() => pickerRef.current?.click()}
					className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<ImageIcon className="size-4" />
				</button>
			</Hint>
		</div>
	);
}

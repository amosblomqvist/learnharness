"use client";

import { useRef, useState } from "react";
import { FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, type ChatAttachment } from "@/src/core";

const acceptedTypes = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
export const ATTACHMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

/** Validate before reading so oversized files never become browser data URLs. */
export function validateAttachmentFiles(files: readonly Pick<File, "name" | "type" | "size">[], existing: readonly ChatAttachment[]): void {
	if (files.length + existing.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`);
	let total = existing.reduce((sum, file) => sum + file.data.length * 3 / 4 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0), 0);
	for (const file of files) {
		if (!acceptedTypes.has(file.type)) throw new Error(`${file.name}: choose a PDF, PNG, JPEG, or WebP file.`);
		if (!file.size) throw new Error(`${file.name}: this file is empty.`);
		if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: files must be 5 MB or smaller.`);
		total += file.size;
	}
	if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments must total 10 MB or less.");
}

function readAttachment(file: File): Promise<ChatAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}. Please try again.`));
		reader.onload = () => {
			const result = String(reader.result);
			resolve({ name: file.name, mimeType: file.type as ChatAttachment["mimeType"], data: result.slice(result.indexOf(",") + 1) });
		};
		reader.readAsDataURL(file);
	});
}

export function useAttachmentDraft() {
	const [files, setFiles] = useState<ChatAttachment[]>([]);
	const [error, setError] = useState<string>();
	const [reading, setReading] = useState(false);
	const readingRef = useRef(false);
	const add = async (selected: FileList | null) => {
		if (!selected?.length || readingRef.current) return;
		readingRef.current = true;
		setReading(true);
		setError(undefined);
		try {
			const incoming = Array.from(selected);
			validateAttachmentFiles(incoming, files);
			const loaded = await Promise.all(incoming.map(readAttachment));
			setFiles((current) => [...current, ...loaded]);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			readingRef.current = false;
			setReading(false);
		}
	};
	return {
		files, error, reading, add,
		remove: (file: ChatAttachment) => setFiles((current) => current.filter((item) => item !== file)),
		accepted: (sent: readonly ChatAttachment[]) => setFiles((current) => current.filter((file) => !sent.includes(file))),
	};
}

export function AttachmentPicker({ disabled, onFiles }: { disabled: boolean; onFiles: (files: FileList | null) => void }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT}
				aria-label="Choose PDFs or photos" className="sr-only" tabIndex={-1}
				onChange={(event) => { onFiles(event.target.files); event.target.value = ""; }}
			/>
			<button
				type="button" aria-label="Attach PDFs or photos"
				title="Attach PDFs or photos (up to 4 files, 5 MB each, 10 MB total)"
				disabled={disabled} onClick={() => input.current?.click()}
				className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
			>
				<PaperclipIcon className="size-4" />
			</button>
		</>
	);
}

export function AttachmentPreview({ file }: { file: ChatAttachment }) {
	const uri = `data:${file.mimeType};base64,${file.data}`;
	return (
		<a href={uri} download={file.name} title={`Download ${file.name}`} className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent">
			{file.mimeType.startsWith("image/") ? (
				// Local, bounded data URLs cannot use the Next image optimization server.
				// eslint-disable-next-line @next/next/no-img-element
				<img src={uri} alt={file.name} width={40} height={40} className="size-10 shrink-0 rounded object-cover" />
			) : <FileTextIcon className="size-5 shrink-0" />}
			<span className="truncate">{file.name}</span>
		</a>
	);
}

export function AttachmentTray({ files, error, reading, disabled, waiting = false, onRemove }: { files: readonly ChatAttachment[]; error?: string; reading: boolean; disabled: boolean; waiting?: boolean; onRemove: (file: ChatAttachment) => void }) {
	if (!files.length && !error && !reading) return null;
	return (
		<div className="px-3 pt-2" aria-live="polite">
			{files.length > 0 && (
				<ul aria-label="Attached files" className="flex flex-wrap gap-2">
					{files.map((file, index) => (
						<li key={index} className="flex min-w-0 max-w-full items-center gap-1">
							<AttachmentPreview file={file} />
							<button type="button" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file)} className="flex size-8 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-40">
								<XIcon className="size-4" />
							</button>
						</li>
					))}
				</ul>
			)}
			{reading && <p className="py-1 text-xs text-muted-foreground">Reading attachments…</p>}
			{waiting && <p className="py-1 text-xs text-muted-foreground">Wait for this turn to finish, then send your attachments. Stop is still available.</p>}
			{error && <p role="alert" className="py-1 text-xs text-destructive">{error}</p>}
			{files.length > 0 && <p className="pt-1 text-xs text-muted-foreground">PDF text is included in your message. Scanned PDFs need selectable text. Photos require an image-capable model.</p>}
		</div>
	);
}

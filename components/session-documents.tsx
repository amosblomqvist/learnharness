"use client";

/**
 * Document-sourced sessions (issue #175) — the two UI pieces:
 *
 * - SourceDocumentsPicker: the CREATION affordance (home's teach composer
 *   and the /chat/new draft). The native file picker pattern is the notes
 *   import's (components/notes-import.tsx): a hidden multiple input with
 *   accept=".md,.markdown,.txt,.pdf", reset after every pick so the same
 *   file can be re-chosen. Chosen files list as removable chips.
 * - SourceDocumentsChips: the SESSION's read-only indicator (chat top bar).
 *
 * The files ride the CREATE request (start-session.ts builds the multipart
 * body); nothing is read in the browser.
 */
import { useRef, type ChangeEvent } from "react";
import { FileTextIcon, XIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import type { SourceDocumentRef } from "@/src/core";

/** The creation-stage chip: a chosen file, removable until the session exists. */
export function ChosenDocumentChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
	return (
		<span
			data-testid="chosen-document-chip"
			className="flex max-w-56 items-center gap-1 rounded-full border border-border bg-card px-2 py-1 font-ui text-xs text-foreground"
		>
			<FileTextIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
			<span className="min-w-0 truncate" title={name}>{name}</span>
			{onRemove && (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="shrink-0 cursor-pointer rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon aria-hidden="true" className="size-3" />
				</button>
			)}
		</span>
	);
}

/** The attach-documents control: one "Add documents" button opening the
 * native picker, plus the chosen files as removable chips. Teach-only
 * surface — the callers hide it in practice mode. */
export function SourceDocumentsPicker({ documents, onFiles }: {
	documents: readonly File[];
	onFiles: (files: File[]) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		const picked = Array.from(event.target.files ?? []);
		// Same-name files are one source (the identity rule); a re-pick of an
		// already-chosen name replaces nothing — the first stays.
		const names = new Set(documents.map((f) => f.name));
		onFiles([...documents, ...picked.filter((f) => !names.has(f.name))]);
		event.target.value = "";
	};
	return (
		<div data-testid="source-documents-picker" className="flex flex-wrap items-center gap-1.5">
			<input ref={inputRef} type="file" multiple accept=".md,.markdown,.txt,.pdf" className="hidden" onChange={onChange} />
			<Hint label="Teach from your own documents" side="bottom">
				<button
					type="button"
					data-testid="add-documents"
					onClick={() => inputRef.current?.click()}
					className={
						"flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 font-ui text-xs transition-colors " +
						(documents.length > 0
							? "border border-border bg-card text-foreground hover:bg-accent"
							: "border border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
					}
				>
					<FileTextIcon aria-hidden="true" className="size-3" />
					{documents.length > 0 ? `Documents (${documents.length})` : "Add documents"}
				</button>
			</Hint>
			{documents.map((file) => (
				<ChosenDocumentChip key={file.name} name={file.name} onRemove={() => onFiles(documents.filter((f) => f !== file))} />
			))}
		</div>
	);
}

/** The session's read-only source indicator (the top bar's chip cluster):
 * one quiet chip per document, the staged material path on hover. */
export function SourceDocumentsChips({ documents }: { documents: readonly SourceDocumentRef[] }) {
	if (documents.length === 0) return null;
	return (
		<span data-testid="source-documents-chips" className="flex min-w-0 items-center gap-1">
			{documents.map((doc) => (
				<span
					key={doc.sourceId}
					title={`Source document: ${doc.name} (converted copy: ${doc.path})`}
					className="flex max-w-40 shrink-0 items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium tracking-wide text-muted-foreground"
				>
					<FileTextIcon aria-hidden="true" className="size-3 shrink-0" />
					<span className="min-w-0 truncate">{doc.name}</span>
				</span>
			))}
		</span>
	);
}

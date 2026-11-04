"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, attachmentExtension, type AttachmentRecord } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { usePopoverDismiss } from "@/components/popover-dismiss";

/**
 * Session context attachments (2026-10-29) — the client side. Picked
 * files wait as chips in the composer and upload ON SEND, one file per
 * request (the API proxy buffers one ATTACHMENT_MAX_BYTES body). A file
 * that uploaded keeps its id, so a retried send never uploads it twice.
 * The top bar's session-files panel lists every file, removes (soft
 * detach) and restores them, and uploads straight to the session.
 */

export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(",");

interface DraftFile {
	key: string;
	file: File;
	/** Set once the file is on the server. */
	id?: string;
}

/** Upload one file to the chat; the stored record, or a thrown Error
 *  carrying a learner-readable reason. */
export async function uploadAttachment(chatId: string, file: File, fetchLike: typeof fetch): Promise<AttachmentRecord> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetchLike(`/api/chats/${chatId}/attachments`, { method: "POST", body: form });
	const body = (await res.json().catch(() => null)) as { attachment?: AttachmentRecord; error?: string } | null;
	if (!res.ok || !body?.attachment) throw new Error(`${file.name}: ${body?.error ?? `upload failed (HTTP ${res.status})`}`);
	return body.attachment;
}

/** Client-side precheck — the server validates again. */
export function precheck(file: File): string | null {
	if (!ATTACHMENT_TYPES[attachmentExtension(file.name)]) return `${file.name}: unsupported type. Attach images, PDFs, or EPUBs.`;
	if (file.size > ATTACHMENT_MAX_BYTES) return `${file.name}: larger than 50 MB.`;
	return null;
}

/** Upsert by id: a record with a known id replaces it in place, new ones append in order. */
export function mergeAttachments(prev: readonly AttachmentRecord[], records: readonly AttachmentRecord[]): AttachmentRecord[] {
	const next = [...prev];
	for (const record of records) {
		const index = next.findIndex((a) => a.id === record.id);
		if (index === -1) next.push(record);
		else next[index] = record;
	}
	return next;
}

/** A learner-facing size: KB under 1 MiB, else MB to one decimal ("820 KB", "4.2 MB"). */
export function formatFileSize(bytes: number): string {
	if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One line of structure facts for a file ("PDF · 3 pages · 120 KB"). */
export function attachmentFacts(a: AttachmentRecord): string {
	const size = formatFileSize(a.bytes);
	if (a.kind === "pdf") return `PDF · ${a.pages ?? "?"} pages · ${size}`;
	if (a.kind === "epub") return `EPUB · ${a.chapters ?? "?"} chapters · ${size}`;
	return `Image · ${size}`;
}

export interface AttachmentDraft {
	files: readonly DraftFile[];
	error: string | null;
	add(list: FileList | null): void;
	remove(key: string): void;
	clear(): void;
	/** Upload every pending file to the chat (in order); the ids of all
	 *  draft files. Throws on the first failure — earlier uploads keep their
	 *  ids for the retry. */
	upload(chatId: string, fetchLike?: typeof fetch): Promise<string[]>;
	/** A stable fingerprint of the picked set (retry identity). */
	identity(): string;
}

export function useAttachmentDraft(onUploaded?: (records: AttachmentRecord[]) => void): AttachmentDraft {
	const [files, setFiles] = useState<DraftFile[]>([]);
	const [error, setError] = useState<string | null>(null);
	// The mirror: upload() runs across renders and must see every id it set.
	const filesRef = useRef<DraftFile[]>([]);
	const write = (next: DraftFile[]) => {
		filesRef.current = next;
		setFiles(next);
	};
	return {
		files,
		error,
		add(list) {
			if (!list) return;
			const problems: string[] = [];
			const added: DraftFile[] = [];
			for (const file of Array.from(list)) {
				const problem = precheck(file);
				if (problem) problems.push(problem);
				else added.push({ key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`, file });
			}
			setError(problems.length ? problems.join("\n") : null);
			write([...filesRef.current, ...added]);
		},
		remove(key) {
			write(filesRef.current.filter((f) => f.key !== key));
			setError(null);
		},
		clear() {
			write([]);
			setError(null);
		},
		async upload(chatId, fetchLike = fetch) {
			setError(null);
			const uploaded: AttachmentRecord[] = [];
			try {
				for (const entry of filesRef.current) {
					if (entry.id) continue;
					const record = await uploadAttachment(chatId, entry.file, fetchLike);
					uploaded.push(record);
					write(filesRef.current.map((f) => (f.key === entry.key ? { ...f, id: record.id } : f)));
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				throw err;
			} finally {
				if (uploaded.length) onUploaded?.(uploaded);
			}
			return filesRef.current.map((f) => f.id!);
		},
		identity() {
			return filesRef.current.map((f) => f.key).join("|");
		},
	};
}

const REMOVE_BUTTON =
	"flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function Chip({ name, detached, onRemove, onOpen }: { name: string; detached?: boolean; onRemove?: () => void; onOpen?: () => void }) {
	const className = "flex max-w-56 items-center gap-1 rounded-full border border-border bg-card py-1 pr-0.5 pl-2.5 font-ui text-xs text-foreground";
	const content = (
		<>
			<PaperclipIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
			<span className={detached ? "truncate line-through text-muted-foreground" : "truncate"}>{name}</span>
			{detached && <span className="text-muted-foreground">removed</span>}
			{onRemove && (
				<button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className={REMOVE_BUTTON}>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			)}
		</>
	);
	if (onOpen) {
		return (
			<button
				type="button"
				data-testid="attachment-chip"
				onClick={onOpen}
				title={`Show ${name} in session files`}
				className={`${className} cursor-pointer hover:bg-accent`}
			>
				{content}
			</button>
		);
	}
	return (
		<span data-testid="attachment-chip" className={className}>
			{content}
		</span>
	);
}

const ADD_BUTTON =
	"flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border/80 bg-transparent px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** The composer's 📎 control: the picker button plus the pending chips.
 *  `lockRemoval` (default: `disabled`) hides the chips' ✕ — the chat locks
 *  it only while an upload runs, never for a streaming turn. */
export function ContextAttachControl({ draft, disabled, lockRemoval = disabled }: { draft: AttachmentDraft; disabled?: boolean; lockRemoval?: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={inputRef}
				type="file"
				multiple
				accept={ATTACHMENT_ACCEPT}
				className="hidden"
				data-testid="attachment-input"
				onChange={(e) => {
					draft.add(e.target.files);
					e.target.value = ""; // allow re-picking the same file
				}}
			/>
			<button
				type="button"
				data-testid="attach-context"
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
				className={ADD_BUTTON}
			>
				<PaperclipIcon aria-hidden="true" className="size-3.5" />
				Add context
			</button>
			{draft.files.map((f) => (
				<Chip key={f.key} name={f.file.name} onRemove={lockRemoval ? undefined : () => draft.remove(f.key)} />
			))}
			{draft.error && (
				<p role="alert" className="w-full whitespace-pre-wrap break-words text-xs text-destructive">
					{draft.error}
				</p>
			)}
		</>
	);
}

/** The transcript's record of what rode a message — read-only; a click
 *  opens the session-files panel on that file. */
export function AttachmentChips({ items, onOpen }: { items: readonly { id: string; name: string; detached: boolean }[]; onOpen?: (id: string) => void }) {
	if (items.length === 0) return null;
	return (
		<div data-testid="message-attachments" className="mt-1.5 flex flex-wrap gap-1.5">
			{items.map((it, i) => (
				<Chip key={`${it.id}-${i}`} name={it.name} detached={it.detached} onOpen={onOpen ? () => onOpen(it.id) : undefined} />
			))}
		</div>
	);
}

const CAPTION = "mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** A file name that truncates in the middle of its base and keeps the extension visible. */
function FileName({ name, removed }: { name: string; removed?: boolean }) {
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	return (
		<span title={name} className={`flex min-w-0 text-sm ${removed ? "line-through text-muted-foreground" : "text-foreground"}`}>
			<span className="truncate">{base}</span>
			<span className="shrink-0">{ext}</span>
		</span>
	);
}

/**
 * The chat top bar's FILES · N chip and its popover: every file of the
 * session, removable (soft detach — the record keeps `detachedAt`) and
 * restorable at any time, plus an upload path that works while a
 * question or probe card blocks the composer. Nothing here sends a
 * message; the tutor sees changes from the next turn.
 */
export function SessionFilesControl({
	chatId,
	attachments,
	setAttachments,
	open,
	onOpenChange,
	highlightId,
	fetchLike = fetch,
}: {
	chatId: string;
	attachments: readonly AttachmentRecord[];
	setAttachments: Dispatch<SetStateAction<AttachmentRecord[]>>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The row to highlight + focus when opened from a transcript chip. */
	highlightId: string | null;
	fetchLike?: typeof fetch;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [uploading, setUploading] = useState<{ key: string; name: string }[]>([]);
	const [error, setError] = useState<string | null>(null);
	usePopoverDismiss(rootRef, open, () => onOpenChange(false));

	const active = attachments.filter((a) => !a.detachedAt);
	const removed = attachments.filter((a) => a.detachedAt);

	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => {
			const row = highlightId ? panelRef.current?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(highlightId)}"]`) : null;
			if (row) {
				row.scrollIntoView({ block: "nearest" });
				row.querySelector<HTMLButtonElement>("button")?.focus();
			} else {
				addRef.current?.focus();
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [open, highlightId]);

	// Escape sends focus home to the chip when it was inside the control or
	// lost to <body> (a disabled Add file, a Remove that moved its row).
	// Capture phase: runs before the dismiss hook's listener closes the panel.
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const focused = document.activeElement;
			if (!focused || focused === document.body || rootRef.current?.contains(focused)) triggerRef.current?.focus();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [open]);

	const setDetached = async (a: AttachmentRecord, detached: boolean) => {
		setPendingId(a.id);
		try {
			const res = await fetchLike(`/api/chats/${chatId}/attachments/${a.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ detached }),
			});
			const body = (await res.json().catch(() => null)) as { attachment?: AttachmentRecord } | null;
			const record = body?.attachment;
			if (!res.ok || !record) throw new Error(`HTTP ${res.status}`);
			setAttachments((prev) => mergeAttachments(prev, [record]));
			setError(null);
		} catch {
			setError(detached ? `Couldn't remove ${a.name}. Try again.` : `Couldn't restore ${a.name}. Try again.`);
		} finally {
			setPendingId(null);
		}
	};

	const addFiles = async (files: File[]) => {
		const problems: string[] = [];
		for (const file of files) {
			const problem = precheck(file);
			if (problem) {
				problems.push(problem);
				continue;
			}
			const key = `${file.name}:${Math.random().toString(36).slice(2)}`;
			setUploading((prev) => [...prev, { key, name: file.name }]);
			try {
				const record = await uploadAttachment(chatId, file, fetchLike);
				setAttachments((prev) => mergeAttachments(prev, [record]));
			} catch (err) {
				problems.push(err instanceof Error ? err.message : String(err));
			} finally {
				setUploading((prev) => prev.filter((u) => u.key !== key));
			}
		}
		setError(problems.length ? problems.join("\n") : null);
	};

	const rowHighlight = (a: AttachmentRecord) => (a.id === highlightId ? "rounded-lg outline outline-1 outline-foreground/40" : "");

	return (
		<div ref={rootRef} className="lh-no-drag relative shrink-0">
			<Hint label="Session files" side="bottom">
				<button
					ref={triggerRef}
					type="button"
					data-testid="session-files-chip"
					aria-expanded={open}
					aria-controls="session-files-panel"
					onClick={(e) => {
						blurAfterPointerClick(e);
						onOpenChange(!open);
					}}
					className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
				>
					<PaperclipIcon className="size-3.5" aria-hidden />
					{active.length > 0 ? `Files · ${active.length}` : "Files"}
				</button>
			</Hint>
			{open && (
				<div
					ref={panelRef}
					id="session-files-panel"
					data-testid="session-files-panel"
					role="dialog"
					aria-label="Session files"
					className="absolute top-full right-0 z-40 mt-1.5 w-80 rounded-xl border bg-card p-3 text-xs shadow-xl"
				>
					<div className={CAPTION}>Session files</div>
					<div className="max-h-72 overflow-y-auto">
						{active.length === 0 && removed.length === 0 && uploading.length === 0 && (
							<p className="text-muted-foreground">No files in this session yet.</p>
						)}
						{active.length > 0 && (
							<ul>
								{active.map((a) => (
									<li
										key={a.id}
										data-testid="session-file"
										data-attachment-id={a.id}
										data-highlighted={a.id === highlightId ? "true" : undefined}
										className={`flex items-center gap-2 px-1.5 py-1.5 ${rowHighlight(a)}`}
									>
										<div className="min-w-0 flex-1">
											<FileName name={a.name} />
											<div className="text-muted-foreground">{attachmentFacts(a)}</div>
										</div>
										<button
											type="button"
											aria-label={`Remove ${a.name}`}
											disabled={pendingId === a.id}
											onClick={() => void setDetached(a, true)}
											className={REMOVE_BUTTON}
										>
											<XIcon aria-hidden="true" className="size-3.5" />
										</button>
									</li>
								))}
							</ul>
						)}
						{uploading.length > 0 && (
							<ul>
								{uploading.map((u) => (
									<li key={u.key} data-testid="session-file-uploading" className="flex items-center gap-2 px-1.5 py-1.5 text-muted-foreground">
										<Loader2Icon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
										<FileName name={u.name} />
									</li>
								))}
							</ul>
						)}
						{removed.length > 0 && (
							<>
								<div className={`${CAPTION} mt-3`}>Removed</div>
								<ul>
									{removed.map((a) => (
										<li
											key={a.id}
											data-testid="session-file-removed"
											data-attachment-id={a.id}
											data-highlighted={a.id === highlightId ? "true" : undefined}
											className={`flex items-center gap-2 px-1.5 py-1.5 ${rowHighlight(a)}`}
										>
											<div className="min-w-0 flex-1">
												<FileName name={a.name} removed />
												<div className="text-muted-foreground">Removed from context</div>
											</div>
											<button
												type="button"
												aria-label={`Undo removing ${a.name}`}
												disabled={pendingId === a.id}
												onClick={() => void setDetached(a, false)}
												className="cursor-pointer text-xs text-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
											>
												Undo
											</button>
										</li>
									))}
								</ul>
							</>
						)}
					</div>
					<div className="my-3 border-t border-border" />
					<p className="text-muted-foreground">Images, PDFs, EPUBs · up to 50 MB each</p>
					<input
						ref={inputRef}
						type="file"
						multiple
						accept={ATTACHMENT_ACCEPT}
						className="hidden"
						data-testid="session-files-input"
						onChange={(e) => {
							const files = Array.from(e.target.files ?? []);
							e.target.value = ""; // allow re-picking the same file
							void addFiles(files);
						}}
					/>
					<button
						ref={addRef}
						type="button"
						data-testid="session-files-add"
						disabled={uploading.length > 0}
						onClick={() => inputRef.current?.click()}
						className={`${ADD_BUTTON} mt-2 w-full justify-center`}
					>
						<PaperclipIcon aria-hidden="true" className="size-3.5" />
						Add file
					</button>
					{error && (
						<p role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">
							{error}
						</p>
					)}
					<p className="mt-2 text-muted-foreground">The tutor sees changes from your next message.</p>
				</div>
			)}
		</div>
	);
}

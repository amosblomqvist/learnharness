"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, ExternalLinkIcon, FolderInputIcon, FolderPlusIcon, LibraryIcon, PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	effectiveTag,
	isInLibrarySubtree,
	LIBRARY_TAG_LABELS,
	LIBRARY_TAGS,
	libraryAncestors,
	libraryChildren,
	librarySubtree,
	type LibraryDeletionImpact,
	type LibraryItem,
	type LibrarySnapshot,
	type LibraryTag,
} from "@/src/core";
import { createFolder, deleteItem, deletionImpact, updateItem, uploadFiles, useLibrary, type UploadOutcome } from "./library-client";
import { FileStatus, formatBytes, ItemGlyph, LIBRARY_ACCEPT, TagBadge, unitsText } from "./library-shared";

/**
 * THE LIBRARY PAGE (course library wave, owner-approved plan 2026-10-29):
 * the full management surface for the shared course library. Left: the
 * folder tree (also drop targets for moves). Right: the open folder's
 * contents — upload (picker or drag-and-drop from the desktop), new
 * folder, and per-item rename / tag / move / delete. The shared TopBar
 * carries no serif title (the title law: the serif title names sessions).
 */

const ITEM_MIME = "application/x-lh-library-item";

export function LibraryView() {
	const { snapshot, error } = useLibrary();
	const [folderId, setFolderId] = useState<string | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [moving, setMoving] = useState<LibraryItem | null>(null);
	const [deleting, setDeleting] = useState<LibraryItem | null>(null);
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [uploads, setUploads] = useState<{ total: number; done: number; failures: UploadOutcome[] } | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
	// The open folder vanished (deleted elsewhere): fall back to the top.
	useEffect(() => {
		if (folderId && snapshot && !items.some((i) => i.id === folderId)) setFolderId(null);
	}, [folderId, items, snapshot]);

	const act = useCallback(async (run: () => Promise<unknown>) => {
		try {
			setActionError(null);
			await run();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const startUpload = async (files: File[]) => {
		if (files.length === 0) return;
		setUploads({ total: files.length, done: 0, failures: [] });
		const results = await uploadFiles(folderId, files, (done) => setUploads((u) => (u ? { ...u, done } : u)));
		const failures = results.filter((r) => !r.ok);
		setUploads(failures.length ? { total: files.length, done: files.length, failures } : null);
	};

	const moveTo = (id: string, parentId: string | null) => act(() => updateItem(id, { parentId }));

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
					<LibraryIcon aria-hidden="true" className="size-3.5" />
					Library
				</span>
				<div className="min-w-4 flex-1" aria-hidden="true" />
				<Button variant="ghost" size="sm" data-testid="library-new-folder" onClick={() => setCreatingFolder(true)}>
					<FolderPlusIcon aria-hidden="true" />
					New folder
				</Button>
				<Button size="sm" data-testid="library-upload" onClick={() => fileInput.current?.click()}>
					<UploadIcon aria-hidden="true" />
					Upload
				</Button>
				<input
					ref={fileInput}
					type="file"
					multiple
					accept={LIBRARY_ACCEPT}
					className="hidden"
					onChange={(e) => {
						const files = Array.from(e.target.files ?? []);
						e.target.value = "";
						void startUpload(files);
					}}
				/>
			</TopBar>

			<div className="flex min-h-0 flex-1">
				<nav aria-label="Library folders" className="w-64 shrink-0 overflow-y-auto border-r border-border p-2">
					<FolderRow
						label="Library"
						active={folderId === null}
						depth={0}
						onOpen={() => setFolderId(null)}
						onDropItem={(id) => void moveTo(id, null)}
					/>
					<FolderTree items={items} parentId={null} depth={1} activeId={folderId} onOpen={setFolderId} onDropItem={(id, target) => void moveTo(id, target)} />
				</nav>

				<UploadZone onFiles={(files) => void startUpload(files)}>
					<Breadcrumb items={items} folderId={folderId} onOpen={setFolderId} />
					{snapshot && !snapshot.libreOffice && items.some((i) => i.file?.format === "docx" || i.file?.format === "pptx") && (
						<p className="mx-4 mb-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
							LibreOffice isn’t installed, so Word and PowerPoint files are read as text plus their embedded pictures. Install LibreOffice and
							upload them again to have slides read exactly as they look.
						</p>
					)}
					{(error || actionError) && <p role="alert" className="mx-4 mb-2 text-sm text-destructive">{actionError ?? error}</p>}
					{uploads && (
						<div className="mx-4 mb-2 rounded-md border border-border/60 px-3 py-2 text-xs" data-testid="library-upload-status">
							{uploads.done < uploads.total ? (
								<span className="text-muted-foreground">Uploading {uploads.done + 1} of {uploads.total}…</span>
							) : (
								<div className="flex flex-col gap-1">
									{uploads.failures.map((f) => (
										<span key={f.name} className="text-destructive">
											{f.name}: {f.ok ? "" : f.error}
										</span>
									))}
									<button type="button" className="self-start text-muted-foreground underline" onClick={() => setUploads(null)}>
										Dismiss
									</button>
								</div>
							)}
						</div>
					)}
					{creatingFolder && (
						<NameField
							initial=""
							placeholder="Folder name"
							onCommit={(name) => {
								setCreatingFolder(false);
								if (name) void act(() => createFolder(folderId, name));
							}}
							onCancel={() => setCreatingFolder(false)}
						/>
					)}
					<FolderContents
						snapshot={snapshot}
						folderId={folderId}
						renamingId={renamingId}
						onOpenFolder={setFolderId}
						onRename={setRenamingId}
						onCommitRename={(id, name) => {
							setRenamingId(null);
							if (name) void act(() => updateItem(id, { name }));
						}}
						onTag={(id, tag) => void act(() => updateItem(id, { tag }))}
						onMove={setMoving}
						onDelete={setDeleting}
						onDropItem={(id, target) => void moveTo(id, target)}
					/>
				</UploadZone>
			</div>

			<MoveDialog
				items={items}
				item={moving}
				onClose={() => setMoving(null)}
				onMove={(target) => {
					const item = moving;
					setMoving(null);
					if (item) void moveTo(item.id, target);
				}}
			/>
			<DeleteLibraryDialog
				item={deleting}
				onClose={() => setDeleting(null)}
				onDeleted={() => setDeleting(null)}
			/>
		</div>
	);
}

// ─── Folder tree ──────────────────────────────────────────────────────────────

function FolderTree({
	items,
	parentId,
	depth,
	activeId,
	onOpen,
	onDropItem,
}: {
	items: readonly LibraryItem[];
	parentId: string | null;
	depth: number;
	activeId: string | null;
	onOpen: (id: string) => void;
	onDropItem: (id: string, target: string) => void;
}) {
	const folders = libraryChildren(items, parentId).filter((i) => i.kind === "folder");
	return (
		<>
			{folders.map((folder) => {
				const open = activeId !== null && isInLibrarySubtree(items, folder.id, activeId);
				return (
					<div key={folder.id}>
						<FolderRow
							label={folder.name}
							tag={folder.tag}
							active={activeId === folder.id}
							open={open}
							depth={depth}
							onOpen={() => onOpen(folder.id)}
							onDropItem={(id) => {
								if (!isInLibrarySubtree(items, id, folder.id)) onDropItem(id, folder.id);
							}}
						/>
						{open && <FolderTree items={items} parentId={folder.id} depth={depth + 1} activeId={activeId} onOpen={onOpen} onDropItem={onDropItem} />}
					</div>
				);
			})}
		</>
	);
}

function FolderRow({
	label,
	tag,
	active,
	open = false,
	depth,
	onOpen,
	onDropItem,
}: {
	label: string;
	tag?: LibraryTag;
	active: boolean;
	open?: boolean;
	depth: number;
	onOpen: () => void;
	onDropItem: (id: string) => void;
}) {
	const [over, setOver] = useState(false);
	return (
		<button
			type="button"
			onClick={onOpen}
			onDragOver={(e) => {
				if (!e.dataTransfer.types.includes(ITEM_MIME)) return;
				e.preventDefault();
				e.stopPropagation();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				const id = e.dataTransfer.getData(ITEM_MIME);
				setOver(false);
				if (!id) return;
				e.preventDefault();
				e.stopPropagation();
				onDropItem(id);
			}}
			style={{ paddingLeft: `${depth * 14 + 8}px` }}
			className={
				"flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors " +
				(over ? "bg-primary/15 ring-1 ring-primary/50 " : active ? "bg-accent text-foreground " : "text-muted-foreground hover:bg-accent/60 hover:text-foreground ")
			}
		>
			{depth === 0 ? (
				<LibraryIcon aria-hidden="true" className="size-4 shrink-0" />
			) : (
				<ItemGlyph item={{ kind: "folder" }} open={open} />
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{tag && <TagBadge tag={tag} />}
		</button>
	);
}

function Breadcrumb({ items, folderId, onOpen }: { items: readonly LibraryItem[]; folderId: string | null; onOpen: (id: string | null) => void }) {
	const folder = folderId ? items.find((i) => i.id === folderId) : undefined;
	const chain = folder ? [...libraryAncestors(items, folder.id), folder] : [];
	return (
		<div className="flex flex-wrap items-center gap-1 px-4 pb-2 pt-4 text-sm" data-testid="library-breadcrumb">
			<button type="button" onClick={() => onOpen(null)} className="rounded px-1 text-muted-foreground hover:text-foreground">
				Library
			</button>
			{chain.map((f) => (
				<span key={f.id} className="flex items-center gap-1">
					<ChevronRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground/60" />
					<button type="button" onClick={() => onOpen(f.id)} className="rounded px-1 text-foreground hover:bg-accent">
						{f.name}
					</button>
				</span>
			))}
		</div>
	);
}

// ─── Folder contents ──────────────────────────────────────────────────────────

/** The open folder's rows — exported for render pins (pure over props). */
export function FolderContents({
	snapshot,
	folderId,
	renamingId,
	onOpenFolder,
	onRename,
	onCommitRename,
	onTag,
	onMove,
	onDelete,
	onDropItem,
}: {
	snapshot: LibrarySnapshot | null;
	folderId: string | null;
	renamingId: string | null;
	onOpenFolder: (id: string) => void;
	onRename: (id: string) => void;
	onCommitRename: (id: string, name: string) => void;
	onTag: (id: string, tag: LibraryTag | null) => void;
	onMove: (item: LibraryItem) => void;
	onDelete: (item: LibraryItem) => void;
	onDropItem: (id: string, target: string) => void;
}) {
	if (!snapshot) return <p className="px-4 text-sm text-muted-foreground">Loading…</p>;
	const items = snapshot.items;
	const children = libraryChildren(items, folderId);
	if (children.length === 0) {
		return (
			<div data-testid="library-empty" className="mx-4 mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
				<UploadIcon aria-hidden="true" className="size-5" />
				{folderId === null
					? "Create a folder for each course (e.g. Math 3339 → Unit 1 → Quizzes), then drop PDFs, Word and PowerPoint files, or images here."
					: "This folder is empty. Drop files here or use Upload."}
			</div>
		);
	}
	return (
		<ul className="flex flex-col px-2 pb-6" data-testid="library-rows">
			{children.map((item) => {
				const tag = effectiveTag(items, item.id);
				const parentTag = item.parentId ? effectiveTag(items, item.parentId) : undefined;
				return (
					<li
						key={item.id}
						draggable={renamingId !== item.id}
						onDragStart={(e) => {
							e.dataTransfer.setData(ITEM_MIME, item.id);
							e.dataTransfer.effectAllowed = "move";
						}}
						onDragOver={(e) => {
							if (item.kind !== "folder" || !e.dataTransfer.types.includes(ITEM_MIME)) return;
							e.preventDefault();
							e.stopPropagation();
						}}
						onDrop={(e) => {
							if (item.kind !== "folder") return;
							const id = e.dataTransfer.getData(ITEM_MIME);
							if (!id || isInLibrarySubtree(items, id, item.id)) return;
							e.preventDefault();
							e.stopPropagation();
							onDropItem(id, item.id);
						}}
						data-testid="library-row"
						className="group flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-accent/40"
					>
						<ItemGlyph item={item} />
						{renamingId === item.id ? (
							<NameField inline initial={item.name} onCommit={(name) => onCommitRename(item.id, name)} onCancel={() => onCommitRename(item.id, "")} />
						) : item.kind === "folder" ? (
							<button type="button" onClick={() => onOpenFolder(item.id)} className="min-w-0 flex-1 truncate text-left text-sm hover:underline">
								{item.name}
							</button>
						) : (
							<a
								href={`/api/library/files/${item.id}/content`}
								target="_blank"
								rel="noreferrer"
								className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm hover:underline"
							>
								<span className="truncate">{item.name}</span>
								<ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0 opacity-0 group-hover:opacity-60" />
							</a>
						)}
						{item.kind === "file" && (
							<span className="shrink-0 text-[11px] text-muted-foreground">
								{unitsText(item)} · {formatBytes(item.file?.bytes ?? 0)}
							</span>
						)}
						{item.file && <FileStatus status={item.file.status} error={item.file.error} summary={snapshot.summaries[item.id]} />}
						{tag && !item.tag && <TagBadge tag={tag} inherited />}
						<TagSelect value={item.tag} inherited={parentTag} onChange={(next) => onTag(item.id, next)} />
						<RowAction label="Rename" onClick={() => onRename(item.id)}>
							<PencilIcon aria-hidden="true" className="size-3.5" />
						</RowAction>
						<RowAction label="Move to…" onClick={() => onMove(item)}>
							<FolderInputIcon aria-hidden="true" className="size-3.5" />
						</RowAction>
						<RowAction label="Delete…" onClick={() => onDelete(item)} danger>
							<Trash2Icon aria-hidden="true" className="size-3.5" />
						</RowAction>
					</li>
				);
			})}
		</ul>
	);
}

/** The item's OWN tag; "Inherit" clears it (the folder above decides). */
export function TagSelect({ value, inherited, onChange }: { value?: LibraryTag; inherited?: LibraryTag; onChange: (tag: LibraryTag | null) => void }) {
	return (
		<select
			aria-label="Tag"
			data-testid="library-tag-select"
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as LibraryTag))}
			className="h-7 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs text-muted-foreground hover:text-foreground"
		>
			<option value="">{inherited ? `Inherit (${LIBRARY_TAG_LABELS[inherited]})` : "No tag"}</option>
			{LIBRARY_TAGS.map((t) => (
				<option key={t} value={t}>
					{LIBRARY_TAG_LABELS[t]}
				</option>
			))}
		</select>
	);
}

function RowAction({ label, onClick, danger = false, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent ${danger ? "hover:text-destructive" : "hover:text-foreground"}`}
		>
			{children}
		</button>
	);
}

function NameField({
	initial,
	placeholder,
	inline = false,
	onCommit,
	onCancel,
}: {
	initial: string;
	placeholder?: string;
	inline?: boolean;
	onCommit: (name: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(initial);
	const done = useRef(false);
	const finish = (commit: boolean) => {
		if (done.current) return;
		done.current = true;
		if (commit && value.trim() && value.trim() !== initial) onCommit(value.trim());
		else onCancel();
	};
	return (
		<input
			autoFocus
			value={value}
			placeholder={placeholder}
			aria-label={placeholder ?? "Name"}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") finish(true);
				else if (e.key === "Escape") {
					e.stopPropagation();
					finish(false);
				}
			}}
			onBlur={() => finish(true)}
			className={`${inline ? "min-w-0 flex-1" : "mx-4 mb-2 w-72"} rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring`}
		/>
	);
}

/** The content pane doubles as the desktop-drop upload target; it claims
 *  file drags so the app-wide path-insertion zone stays out of it. */
function UploadZone({ onFiles, children }: { onFiles: (files: File[]) => void; children: React.ReactNode }) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
	return (
		<section
			data-testid="library-content"
			onDragEnter={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				depth.current++;
				setOver(true);
			}}
			onDragOver={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(e) => {
				if (!hasFiles(e)) return;
				e.stopPropagation();
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setOver(false);
			}}
			onDrop={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				depth.current = 0;
				setOver(false);
				onFiles(Array.from(e.dataTransfer.files));
			}}
			className={`relative min-w-0 flex-1 overflow-y-auto ${over ? "bg-primary/5 ring-2 ring-inset ring-primary/40" : ""}`}
		>
			{children}
		</section>
	);
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

function useEscape(active: boolean, onEscape: () => void) {
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onEscape();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [active, onEscape]);
}

function MoveDialog({ items, item, onClose, onMove }: { items: readonly LibraryItem[]; item: LibraryItem | null; onClose: () => void; onMove: (target: string | null) => void }) {
	const backdrop = useBackdropDismiss(onClose);
	useEscape(item !== null, onClose);
	if (!item) return null;
	// Destinations: the top level and every folder outside the item's own subtree.
	const blocked = new Set(librarySubtree(items, item.id).map((i) => i.id));
	const folders = items.filter((i) => i.kind === "folder" && !blocked.has(i.id));
	const pathOf = (f: LibraryItem) => [...libraryAncestors(items, f.id), f].map((x) => x.name).join(" / ");
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
			<div role="dialog" aria-modal="true" aria-label="Move item" onClick={(e) => e.stopPropagation()} className="flex max-h-[70vh] w-[28rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl">
				<h2 className="text-sm font-semibold">Move “{item.name}” to…</h2>
				<div className="mt-3 flex-1 overflow-y-auto rounded-lg border border-border/60 p-1">
					<button type="button" disabled={item.parentId === null} onClick={() => onMove(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40">
						<LibraryIcon aria-hidden="true" className="size-4" />
						Library (top level)
					</button>
					{folders
						.map((f) => ({ f, path: pathOf(f) }))
						.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
						.map(({ f, path }) => (
							<button key={f.id} type="button" disabled={item.parentId === f.id} onClick={() => onMove(f.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40">
								<ItemGlyph item={f} />
								<span className="truncate">{path}</span>
							</button>
						))}
				</div>
				<div className="mt-4 flex justify-end">
					<Button variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function DeleteLibraryDialog({ item, onClose, onDeleted }: { item: LibraryItem | null; onClose: () => void; onDeleted: () => void }) {
	const [impact, setImpact] = useState<LibraryDeletionImpact | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdrop = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useEscape(item !== null, onClose);
	useEffect(() => {
		setImpact(null);
		setFailure(null);
		setBusy(false);
		if (!item) return;
		let live = true;
		deletionImpact(item.id)
			.then((r) => live && setImpact(r.impact))
			.catch((e: unknown) => live && setFailure(e instanceof Error ? e.message : String(e)));
		return () => {
			live = false;
		};
	}, [item]);
	if (!item) return null;
	const run = async () => {
		setBusy(true);
		try {
			await deleteItem(item.id);
			onDeleted();
		} catch (e) {
			setFailure(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
			<DeleteLibraryBody item={item} impact={impact} busy={busy} failure={failure} onClose={onClose} onRun={() => void run()} />
		</div>,
		document.body,
	);
}

/** The delete confirm's pure body (SSR pins). Lists the chats that use the
 *  item (owner ruling: warn, then detach). */
export function DeleteLibraryBody({
	item,
	impact,
	busy,
	failure,
	onClose,
	onRun,
}: {
	item: Pick<LibraryItem, "name" | "kind">;
	impact: LibraryDeletionImpact | null;
	busy: boolean;
	failure: string | null;
	onClose: () => void;
	onRun: () => void;
}) {
	const fileCount = impact ? impact.itemIds.length - 1 : 0;
	return (
		<div role="dialog" aria-modal="true" aria-label="Delete library item" data-testid="library-delete-dialog" onClick={(e) => e.stopPropagation()} className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
			<h2 className="text-sm font-semibold text-destructive">Delete {item.kind === "folder" ? "folder" : "file"}?</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{item.name}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				{item.kind === "folder" && impact && fileCount > 0
					? `This permanently removes the folder and the ${fileCount} item${fileCount === 1 ? "" : "s"} inside it from your library. `
					: "This permanently removes it from your library. "}
				Past messages that used it stay as they are. This cannot be undone.
			</p>
			{impact === null && !failure && <p className="mt-3 text-xs text-muted-foreground">Checking which chats use it…</p>}
			{impact && impact.chats.length > 0 && (
				<div className="mt-3 rounded-lg border border-border/60 px-3 py-2" data-testid="library-delete-chats">
					<p className="text-xs text-foreground">
						Used by {impact.chats.length} chat{impact.chats.length === 1 ? "" : "s"}. It will be detached from:
					</p>
					<ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
						{impact.chats.slice(0, 8).map((c) => (
							<li key={c.id}>{c.title}</li>
						))}
						{impact.chats.length > 8 && <li>and {impact.chats.length - 8} more</li>}
					</ul>
				</div>
			)}
			{failure && <p role="alert" className="mt-3 text-sm text-destructive">{failure}</p>}
			<div className="mt-5 flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
					Cancel
				</Button>
				<Button variant="destructive" size="sm" data-testid="library-delete-confirm" onClick={onRun} disabled={busy || impact === null}>
					Delete
				</Button>
			</div>
		</div>
	);
}

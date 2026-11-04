"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownIcon, ArrowUpIcon, ExternalLinkIcon, FolderPlusIcon, LibraryIcon, SearchIcon, UploadIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { EditableSourceName, isRowControlClick, rowClickMode, SourceDragRow, SourceFolderTree, sourceNameMatches, type OrganizationChange, type RowClickMode } from "@/components/source-folder-tree";
import type { ChainSort, ChainSortCol } from "@/components/chain-table";
import {
	LIBRARY_TAG_LABELS,
	LIBRARY_TAGS,
	libraryAncestors,
	librarySubtree,
	type LibraryDeletionImpact,
	type LibraryItem,
	type LibrarySnapshot,
	type LibraryTag,
	type SourceEntrySelection,
} from "@/src/core";
import { createFolder, deleteItem, deletionImpact, updateItem, uploadFiles, useLibrary, type UploadOutcome } from "./library-client";
import { FileStatus, FormatGlyph, formatBytes, ItemGlyph, LIBRARY_ACCEPT, TagBadge, unitsText } from "./library-shared";
import {
	EMPTY_SELECTION,
	isRowSelected,
	libraryDirectory,
	libraryTreeFiles,
	onlySelection,
	pruneSelection,
	rowClickSelection,
	rowRange,
	singleCheckedFolder,
	toggleRowSelection,
	topMostSelected,
	treeKeyAction,
	unionSelection,
	type LibraryTreeFile,
	type TreeRow,
} from "./library-tree";

const fileContentUrl = (id: string) => `/api/library/files/${id}/content`;
const openFile = (id: string) => window.open(fileContentUrl(id), "_blank", "noopener,noreferrer");

/**
 * THE LIBRARY PAGE (course library wave; owner ruling 2026-11-03: built on
 * main's SourceFolderTree, reused as-is through library-tree.ts). One
 * indented tree like the Chains table — folder rows are main's own
 * (checkbox, expand, inline rename, file count, date, drag to move); file
 * rows are lean (checkbox, icon, inline rename, pages/size, status, tag).
 * Tags are FILE-ONLY. A toolbar acts on checked items: Tag (every checked
 * file), Move to…, Delete… (top-most checked items), Clear. Upload goes into
 * the single checked folder, else the top level; a desktop drop onto a
 * folder row goes into that folder. The shared TopBar carries no serif
 * title (the title law: the serif title names sessions).
 */

const EXPANDED_KEY = "lh:library-expanded";
const DEFAULT_SORT: ChainSort = { col: "name", dir: 1 };

function readExpanded(): Set<string> {
	try {
		const raw = window.localStorage.getItem(EXPANDED_KEY);
		const ids = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function writeExpanded(ids: ReadonlySet<string>): void {
	try {
		window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
	} catch {
		/* storage unavailable — the tree still works, just forgets on reload */
	}
}

export function LibraryView() {
	const { snapshot, error } = useLibrary();
	const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
	const directory = useMemo(() => libraryDirectory(items), [items]);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<ChainSort>(DEFAULT_SORT);
	const [selection, setSelection] = useState<SourceEntrySelection>(EMPTY_SELECTION);
	// Folders the user clicked (the Upload / New folder target — see
	// singleCheckedFolder); main's selection auto-checks parents too.
	const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [creatingFolder, setCreatingFolder] = useState(false);
	// The one item whose name is being edited (started from the toolbar's Rename).
	const [renaming, setRenaming] = useState<string | null>(null);
	// The selection before the latest row click: a double-click's first click
	// selects, so the double-click puts this back (owner ruling 2026-11-03).
	const beforeRowClick = useRef<{ selection: SourceEntrySelection; picked: ReadonlySet<string>; anchor: string | null } | null>(null);
	const [moving, setMoving] = useState<LibraryItem[] | null>(null);
	const [deleting, setDeleting] = useState<LibraryItem[] | null>(null);
	const [uploads, setUploads] = useState<{ total: number; done: number; failures: UploadOutcome[] } | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	// The tree's rows in on-screen order are read from the DOM (sort, search
	// and expansion included). The anchor is where Shift ranges start.
	const treeRef = useRef<HTMLDivElement>(null);
	const anchor = useRef<string | null>(null);
	// Set by a mouse press: only keyboard focus (Tab) is redirected to a row.
	const pointerFocus = useRef(false);

	// Expanded folders persist per window (localStorage), read after mount so
	// the server render and the first client render agree.
	useEffect(() => setExpanded(readExpanded()), []);
	// Items deleted elsewhere (or by this page) leave the selection.
	useEffect(() => setSelection((s) => pruneSelection(items, s)), [items]);

	const files = useMemo(
		() => libraryTreeFiles(items).filter((f) => sourceNameMatches(directory, f.key, f.label, query)),
		[items, directory, query],
	);
	const checked = useMemo(() => topMostSelected(items, selection), [items, selection]);
	const checkedFiles = useMemo(() => items.filter((i) => i.kind === "file" && selection.sources.has(i.id)), [items, selection]);
	const target = singleCheckedFolder(items, selection, picked);
	const targetName = target ? items.find((i) => i.id === target)?.name : undefined;

	const act = useCallback(async (run: () => Promise<unknown>) => {
		try {
			setActionError(null);
			await run();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const toggleExpanded = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			writeExpanded(next);
			return next;
		});

	const rowElements = () => [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-source-drag-row]") ?? [])];
	const visibleRows = (): TreeRow[] =>
		rowElements().map((el) => {
			const id = el.dataset.sourceDragRow!;
			return { id, kind: items.some((i) => i.id === id && i.kind === "folder") ? "folder" : "source" };
		});
	const focusRow = (id: string) => {
		const el = rowElements().find((e) => e.dataset.sourceDragRow === id);
		el?.focus({ preventScroll: true });
		el?.scrollIntoView?.({ block: "nearest" });
	};

	/** Every way a row gets selected. "only" is a plain click (again =
	 *  deselect); "move" is an arrow key (always selects); "toggle" is
	 *  Cmd/Ctrl-click or Space; "range" is Shift from the anchor. */
	const selectRow = (kind: TreeRow["kind"], id: string, mode: RowClickMode | "move") => {
		const range = mode === "range" && anchor.current !== null ? rowRange(visibleRows(), anchor.current, id) : [];
		if (mode === "range" && range.length === 0) mode = "only";
		let next: SourceEntrySelection, nextPicked: ReadonlySet<string>;
		if (mode === "range") {
			next = unionSelection(directory, range);
			nextPicked = new Set(range.filter((r) => r.kind === "folder").map((r) => r.id));
		} else if (mode === "toggle") {
			next = toggleRowSelection(directory, selection, kind, id);
			const p = new Set(picked);
			if (kind === "folder") {
				if (next.folders.has(id)) p.add(id);
				else for (const sub of librarySubtree(items, id)) p.delete(sub.id);
			}
			nextPicked = p;
			anchor.current = id;
		} else {
			next = mode === "move" ? onlySelection(directory, kind, id) : rowClickSelection(directory, selection, kind, id);
			nextPicked = kind === "folder" && next.folders.has(id) ? new Set([id]) : new Set();
			anchor.current = id;
		}
		setSelection(next);
		setPicked(nextPicked);
		focusRow(id);
	};

	const clearSelection = () => {
		setSelection(EMPTY_SELECTION);
		setPicked(new Set());
		anchor.current = null;
	};

	/** Finder-style keys (owner ruling 2026-11-03). Keys typed in the rename
	 *  box, and Space/Enter on a row's own buttons and links, pass through. */
	const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const t = e.target as Element;
		if (t.closest('input,textarea,select,[contenteditable="true"]')) return;
		const rows = visibleRows();
		const rowEl = t.closest<HTMLElement>("[data-source-drag-row]");
		const action = treeKeyAction(
			rows,
			rows.findIndex((r) => r.id === rowEl?.dataset.sourceDragRow),
			{ key: e.key, shift: e.shiftKey, mod: e.metaKey || e.ctrlKey, alt: e.altKey, onControl: t.closest("button,a") !== null },
			{
				expanded: (id) => rowElements().find((el) => el.dataset.sourceDragRow === id)?.dataset.chainNavExpanded === "true",
				parentOf: (id) => items.find((i) => i.id === id)?.parentId ?? null,
				hasSelection: selection.sources.size > 0 || selection.folders.size > 0,
			},
		);
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		if (action.type === "select") selectRow(action.row.kind, action.row.id, action.mode);
		else if (action.type === "expand") toggleExpanded(action.id);
		else if (action.type === "open") openFile(action.id);
		else if (action.type === "clear") clearSelection();
		else {
			setSelection(unionSelection(directory, rows));
			setPicked(new Set());
		}
	};

	const startUpload = async (picked: File[], parentId: string | null) => {
		if (picked.length === 0) return;
		setUploads({ total: picked.length, done: 0, failures: [] });
		const results = await uploadFiles(parentId, picked, (done) => setUploads((u) => (u ? { ...u, done } : u)));
		const failures = results.filter((r) => !r.ok);
		setUploads(failures.length ? { total: picked.length, done: picked.length, failures } : null);
	};

	// Main's tree speaks OrganizationAction; each maps onto the library API.
	const onAction: OrganizationChange = async (action) => {
		setActionError(null);
		switch (action.action) {
			case "create-folder":
				return (await createFolder(action.parentId, action.name)).item.id;
			case "rename-folder":
			case "rename-source":
				await updateItem(action.id, { name: action.name });
				return;
			case "move":
				await updateItem(action.id, { parentId: action.parentId });
				return;
			case "delete-folder": {
				const folder = items.find((i) => i.id === action.id);
				if (folder) setDeleting([folder]);
				return;
			}
		}
	};

	const onSort = (col: ChainSortCol) =>
		setSort((s) => (s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: col === "name" ? 1 : -1 }));

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
					<LibraryIcon aria-hidden="true" className="size-3.5" />
					Library
				</span>
				<div className="min-w-4 flex-1" aria-hidden="true" />
				<span className="relative w-56">
					<SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						data-testid="library-search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setQuery("");
								e.currentTarget.blur();
							}
						}}
						placeholder="Search…"
						aria-label="Search the library"
						className="h-8 pl-7 text-sm"
					/>
				</span>
				<Button variant="ghost" size="sm" data-testid="library-new-folder" onClick={() => setCreatingFolder(true)} title={targetName ? `New folder inside ${targetName}` : "New folder at the top level"}>
					<FolderPlusIcon aria-hidden="true" />
					New folder
				</Button>
				<Button size="sm" data-testid="library-upload" onClick={() => fileInput.current?.click()} title={targetName ? `Upload into ${targetName}` : "Upload to the top level"}>
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
						const picked = Array.from(e.target.files ?? []);
						e.target.value = "";
						void startUpload(picked, target);
					}}
				/>
			</TopBar>

			{snapshot && !snapshot.libreOffice && items.some((i) => i.file?.format === "docx" || i.file?.format === "pptx") && (
				<p className="mx-4 mt-3 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
					LibreOffice isn’t installed, so Word and PowerPoint files are read as text plus their embedded pictures. Install LibreOffice and upload
					them again to have slides read exactly as they look.
				</p>
			)}
			{(error || actionError) && <p role="alert" className="mx-4 mt-3 text-sm text-destructive">{actionError ?? error}</p>}
			{uploads && <UploadStatus uploads={uploads} onDismiss={() => setUploads(null)} />}

			{/* Always shown (owner ruling 2026-11-03); controls disable with no selection. */}
			<SelectionToolbar
				checked={checked}
				files={checkedFiles}
				onTag={(tag) => void act(async () => {
					for (const f of checkedFiles) await updateItem(f.id, { tag });
				})}
				onRename={() => {
					const item = checked[0];
					if (checked.length !== 1 || !item) return;
					// Open collapsed ancestors so the row being renamed is visible.
					const closed = libraryAncestors(items, item.id).filter((a) => !expanded.has(a.id));
					if (closed.length) {
						setExpanded((prev) => {
							const next = new Set(prev);
							for (const a of closed) next.add(a.id);
							writeExpanded(next);
							return next;
						});
					}
					setRenaming(item.id);
				}}
				onMove={() => setMoving(checked)}
				onDelete={() => setDeleting(checked)}
				onClear={clearSelection}
			/>

			<TreeHeader sort={sort} onSort={onSort} />

			<UploadZone items={items} onFiles={(picked, parentId) => void startUpload(picked, parentId)}>
				{creatingFolder && (
					<div className="flex items-center px-3 py-2" data-testid="library-new-folder-row">
						<EditableSourceName
							name=""
							initiallyEditing
							onCancel={() => setCreatingFolder(false)}
							onSave={async (name) => {
								const id = await onAction({ action: "create-folder", name, parentId: target });
								if (target) setExpanded((prev) => {
									const next = new Set(prev).add(target);
									writeExpanded(next);
									return next;
								});
								if (typeof id === "string") setQuery("");
								setCreatingFolder(false);
							}}
						/>
					</div>
				)}
				{snapshot && items.length === 0 && !creatingFolder && <EmptyLibrary />}
				{!snapshot && !error && <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>}
				{snapshot && items.length > 0 && (
					<div
						ref={treeRef}
						tabIndex={0}
						aria-label="Library items"
						data-testid="library-tree"
						className="flex flex-1 flex-col outline-none"
						onKeyDown={onTreeKeyDown}
						onMouseDown={() => {
							pointerFocus.current = true;
						}}
						onMouseUp={() => {
							pointerFocus.current = false;
						}}
						onFocus={(e) => {
							// Tab into the tree lands on the first selected row, else the first row.
							if (pointerFocus.current || e.target !== e.currentTarget || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
							const rows = visibleRows();
							const first = rows.find((r) => isRowSelected(selection, r.kind, r.id)) ?? rows[0];
							if (first) focusRow(first.id);
						}}
					>
						<LibraryTree
							files={files}
							snapshot={snapshot}
							directory={directory}
							query={query}
							sort={sort}
							selection={selection}
							expanded={expanded}
							onToggleExpanded={toggleExpanded}
							onRowDoubleClick={() => {
								const before = beforeRowClick.current;
								beforeRowClick.current = null;
								if (!before) return;
								setSelection(before.selection);
								setPicked(before.picked);
								anchor.current = before.anchor;
							}}
							renaming={renaming}
							onRenameDone={() => setRenaming(null)}
							onRowClick={(kind, id, mode) => {
								beforeRowClick.current = { selection, picked, anchor: anchor.current };
								selectRow(kind, id, mode);
							}}
							onAction={(action) => onAction(action).catch((e: unknown) => {
								setActionError(e instanceof Error ? e.message : String(e));
								throw e;
							})}
						/>
					</div>
				)}
			</UploadZone>

			<MoveDialog
				allItems={items}
				moving={moving}
				onClose={() => setMoving(null)}
				onMove={(parentId) => {
					const batch = moving ?? [];
					setMoving(null);
					void act(async () => {
						for (const item of batch) await updateItem(item.id, { parentId });
					});
				}}
			/>
			<DeleteLibraryDialog targets={deleting} onClose={() => setDeleting(null)} onDeleted={() => setDeleting(null)} />
		</div>
	);
}

// ─── The tree (main's SourceFolderTree + library file rows) ──────────────────

/** Pure over props — render pins cover it. */
export function LibraryTree({
	files,
	snapshot,
	directory,
	query,
	sort,
	selection,
	expanded,
	onToggleExpanded,
	onRowClick,
	onRowDoubleClick,
	renaming = null,
	onRenameDone = () => {},
	onAction,
}: {
	files: LibraryTreeFile[];
	snapshot: LibrarySnapshot;
	directory: ReturnType<typeof libraryDirectory>;
	query: string;
	sort: ChainSort;
	selection: SourceEntrySelection;
	expanded: ReadonlySet<string>;
	onToggleExpanded: (id: string) => void;
	/** A row click outside its controls; the mode comes from the modifier keys. */
	onRowClick?: (kind: TreeRow["kind"], id: string, mode: RowClickMode) => void;
	/** After a row double-click (open/expand): undo its first click's selection. */
	onRowDoubleClick?: () => void;
	/** The item being renamed (names are plain text otherwise). */
	renaming?: string | null;
	onRenameDone?: () => void;
	onAction?: OrganizationChange;
}) {
	return (
		<SourceFolderTree
			groups={files}
			directory={directory}
			query={query}
			sort={sort}
			onAction={onAction}
			sourceSelection={selection}
			expanded={expanded}
			collapsedForSearch={new Set()}
			onToggleExpanded={onToggleExpanded}
			selection={selection.sources}
			selectedFolders={selection.folders}
			onToggleNodes={() => {}}
			onToggleFolder={() => {}}
			onSelectFolderRow={onRowClick ? (id, mode) => onRowClick("folder", id, mode) : undefined}
			onFolderRowDoubleClick={onRowDoubleClick}
			folderRename={{ id: renaming, onDone: onRenameDone }}
			hideFolderCheckbox
			renderSource={(file, depth) => (
				<LibraryFileRow
					key={file.key}
					file={file.item}
					depth={depth}
					summary={snapshot.summaries[file.key]}
					selected={selection.sources.has(file.key)}
					onRowClick={onRowClick ? (mode) => onRowClick("source", file.key, mode) : undefined}
					onRowDoubleClick={onRowDoubleClick}
					renaming={renaming === file.key}
					onRenameDone={onRenameDone}
					onRename={onAction ? (name) => onAction({ action: "rename-source", id: file.key, name }) : undefined}
				/>
			)}
		/>
	);
}

/** A lean file row: checkbox, icon, inline rename (main's EditableSourceName)
 *  + an open link, pages/size, status, tag; the columns line up with main's
 *  folder rows (count, then date). Draggable onto folders via main's row. */
export function LibraryFileRow({
	file,
	depth,
	summary,
	selected,
	onRowClick,
	onRowDoubleClick,
	renaming = false,
	onRenameDone = () => {},
	onRename,
}: {
	file: LibraryItem;
	depth: number;
	summary?: LibrarySnapshot["summaries"][string];
	selected: boolean;
	onRowClick?: (mode: RowClickMode) => void;
	onRowDoubleClick?: () => void;
	renaming?: boolean;
	onRenameDone?: () => void;
	onRename?: (name: string) => Promise<unknown>;
}) {
	return (
		<SourceDragRow
			kind="source"
			id={file.id}
			name={file.name}
			enabled={Boolean(onRename)}
			data-testid={`library-file-${file.id}`}
			data-selected={selected || undefined}
			tabIndex={-1}
			className={`group flex items-center gap-1 border-b border-transparent py-1.5 pr-3 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${onRowClick ? "cursor-pointer hover:bg-accent/50" : ""} ${selected ? "bg-primary/10" : ""}`}
			style={{ paddingLeft: 12 + depth * 36 }}
			onMouseDown={onRowClick ? (e) => { if (e.shiftKey && !isRowControlClick(e.target)) e.preventDefault(); } : undefined}
			onClick={onRowClick ? (e) => { if (e.detail <= 1 && !isRowControlClick(e.target)) onRowClick(rowClickMode(e)); } : undefined}
			onDoubleClick={onRowClick ? (e) => {
				if (isRowControlClick(e.target)) return;
				openFile(file.id);
				onRowDoubleClick?.();
			} : undefined}
		>
			{/* The expander column stays empty for files so names align with folders. */}
			<span className="w-3.5 shrink-0" aria-hidden="true" />
			<span data-source-icon className="flex h-5 w-3.5 shrink-0 items-center justify-center">
				{file.file ? <FormatGlyph format={file.file.format} className="size-3.5" /> : <ItemGlyph item={file} className="size-3.5" />}
			</span>
			{onRename && renaming ? (
				<EditableSourceName
					name={file.name}
					initiallyEditing
					onCancel={onRenameDone}
					onSave={async (name) => {
						if (name !== file.name) await onRename(name);
						onRenameDone();
					}}
				/>
			) : (
				<span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
			)}
			<a
				href={fileContentUrl(file.id)}
				target="_blank"
				rel="noreferrer"
				aria-label={`Open ${file.name}`}
				title="Open"
				className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
			>
				<ExternalLinkIcon aria-hidden="true" className="size-3" />
			</a>
			<span className="shrink-0 text-[11px] text-muted-foreground">
				{unitsText(file)} · {formatBytes(file.file?.bytes ?? 0)}
			</span>
			{file.file && <FileStatus status={file.file.status} error={file.file.error} summary={summary} />}
			{file.tag && <TagBadge tag={file.tag} />}
			{/* Files column: a file is one file — left blank so folder counts read cleanly. */}
			<span className="w-14 shrink-0" aria-hidden="true" />
			<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{file.createdAt.slice(0, 10)}</span>
		</SourceDragRow>
	);
}

function TreeHeader({ sort, onSort }: { sort: ChainSort; onSort: (col: ChainSortCol) => void }) {
	const dirIcon = (col: ChainSortCol) =>
		sort.col !== col ? null : sort.dir === 1 ? <ArrowUpIcon aria-hidden="true" className="size-3" /> : <ArrowDownIcon aria-hidden="true" className="size-3" />;
	const aria = (col: ChainSortCol) => (sort.col === col ? (sort.dir === 1 ? "ascending" : "descending") : "none");
	return (
		<div className="mt-2 flex items-center gap-1 border-b border-border/60 px-3 pb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground" data-testid="library-tree-header">
			<button type="button" data-testid="library-sort-name" onClick={() => onSort("name")} aria-sort={aria("name")} className="flex flex-1 items-center gap-1 pl-[24px] text-left transition-colors hover:text-foreground">
				Name {dirIcon("name")}
			</button>
			<button type="button" data-testid="library-sort-files" onClick={() => onSort("props")} aria-sort={aria("props")} className="flex w-14 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground">
				Files {dirIcon("props")}
			</button>
			<button type="button" data-testid="library-sort-created" onClick={() => onSort("created")} aria-sort={aria("created")} className="flex w-20 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground">
				Created {dirIcon("created")}
			</button>
		</div>
	);
}

/** The checked-items toolbar — pure over props (render pins). Tag applies to
 *  every checked FILE (tags are file-only); Move/Delete to the top-most
 *  checked items. With exactly one checked file, the tag menu shows its tag. */
export function SelectionToolbar({
	checked,
	files,
	onTag,
	onRename,
	onMove,
	onDelete,
	onClear,
}: {
	checked: readonly LibraryItem[];
	files: readonly LibraryItem[];
	onTag: (tag: LibraryTag | null) => void;
	onRename: () => void;
	onMove: () => void;
	onDelete: () => void;
	onClear: () => void;
}) {
	const folders = checked.filter((i) => i.kind === "folder").length;
	const parts = [
		files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"}` : null,
		folders > 0 ? `${folders} folder${folders === 1 ? "" : "s"}` : null,
	].filter(Boolean);
	const single = files.length === 1 ? files[0]!.tag ?? "" : undefined;
	const none = checked.length === 0;
	return (
		<div className="mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-1.5" data-testid="library-toolbar">
			<span className="text-xs text-muted-foreground" data-testid="library-toolbar-count">
				{none ? "No selection" : `${parts.join(", ")} selected`}
			</span>
			<span className="flex-1" />
			<select
				aria-label="Tag the selected files"
				data-testid="library-toolbar-tag"
				disabled={files.length === 0}
				value={single ?? "__mixed"}
				onChange={(e) => {
					if (e.target.value === "__mixed") return;
					onTag(e.target.value === "" ? null : (e.target.value as LibraryTag));
				}}
				className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
			>
				{single === undefined && <option value="__mixed">Tag…</option>}
				<option value="">No tag</option>
				{LIBRARY_TAGS.map((t) => (
					<option key={t} value={t}>
						{LIBRARY_TAG_LABELS[t]}
					</option>
				))}
			</select>
			<Button variant="ghost" size="xs" data-testid="library-toolbar-rename" disabled={checked.length !== 1} onClick={onRename}>
				Rename…
			</Button>
			<Button variant="ghost" size="xs" data-testid="library-toolbar-move" disabled={none} onClick={onMove}>
				Move to…
			</Button>
			<Button variant="ghost" size="xs" data-testid="library-toolbar-delete" disabled={none} onClick={onDelete} className="hover:text-destructive">
				Delete…
			</Button>
			<Button variant="ghost" size="xs" data-testid="library-toolbar-clear" disabled={none} onClick={onClear}>
				Clear
			</Button>
		</div>
	);
}

function UploadStatus({ uploads, onDismiss }: { uploads: { total: number; done: number; failures: UploadOutcome[] }; onDismiss: () => void }) {
	return (
		<div className="mx-4 mt-3 rounded-md border border-border/60 px-3 py-2 text-xs" data-testid="library-upload-status">
			{uploads.done < uploads.total ? (
				<span className="text-muted-foreground">Uploading {uploads.done + 1} of {uploads.total}…</span>
			) : (
				<div className="flex flex-col gap-1">
					{uploads.failures.map((f) => (
						<span key={f.name} className="text-destructive">
							{f.name}: {f.ok ? "" : f.error}
						</span>
					))}
					<button type="button" className="self-start text-muted-foreground underline" onClick={onDismiss}>
						Dismiss
					</button>
				</div>
			)}
		</div>
	);
}

function EmptyLibrary() {
	return (
		<div data-testid="library-empty" className="mx-4 mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
			<UploadIcon aria-hidden="true" className="size-5" />
			Create a folder for each course (e.g. Math 3339 → Unit 1 → Quizzes), then drop PDFs, Word and PowerPoint files, or images here.
		</div>
	);
}

/** The tree area doubles as the desktop-drop upload target. A drop onto a
 *  folder row (main's rows carry data-source-drag-row) uploads into that
 *  folder; anywhere else, the top level. It claims file drags so the
 *  app-wide path-insertion zone stays out — main's tree ignores them. */
function UploadZone({ items, onFiles, children }: { items: readonly LibraryItem[]; onFiles: (files: File[], parentId: string | null) => void; children: React.ReactNode }) {
	const [over, setOver] = useState<{ folder: string | null } | null>(null);
	const depth = useRef(0);
	const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
	const folderAt = (target: EventTarget | null): string | null => {
		const row = target instanceof Element ? target.closest("[data-source-drag-row]") : null;
		const id = row?.getAttribute("data-source-drag-row") ?? null;
		return id && items.some((i) => i.id === id && i.kind === "folder") ? id : null;
	};
	const overName = over?.folder ? items.find((i) => i.id === over.folder)?.name : null;
	return (
		<section
			data-testid="library-content"
			onDragEnter={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				depth.current++;
				setOver({ folder: folderAt(e.target) });
			}}
			onDragOver={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "copy";
				const folder = folderAt(e.target);
				if (over?.folder !== folder) setOver({ folder });
			}}
			onDragLeave={(e) => {
				if (!hasFiles(e)) return;
				e.stopPropagation();
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setOver(null);
			}}
			onDrop={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				depth.current = 0;
				setOver(null);
				onFiles(Array.from(e.dataTransfer.files), folderAt(e.target));
			}}
			className={`relative flex min-w-0 flex-1 flex-col overflow-y-auto ${over ? "bg-primary/5 ring-2 ring-inset ring-primary/40" : ""}`}
		>
			{over && (
				<p className="pointer-events-none sticky top-0 z-10 mx-auto mt-2 rounded-full border border-primary/40 bg-card px-3 py-1 text-xs text-foreground shadow" data-testid="library-drop-target">
					{overName ? `Drop to upload into ${overName}` : "Drop to upload to the top level"}
				</p>
			)}
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

function MoveDialog({ allItems, moving, onClose, onMove }: { allItems: readonly LibraryItem[]; moving: LibraryItem[] | null; onClose: () => void; onMove: (target: string | null) => void }) {
	const backdrop = useBackdropDismiss(onClose);
	useEscape(moving !== null, onClose);
	if (!moving || moving.length === 0) return null;
	// Destinations: the top level and every folder outside the moving items' subtrees.
	const blocked = new Set(moving.flatMap((m) => librarySubtree(allItems, m.id).map((i) => i.id)));
	const folders = allItems.filter((i) => i.kind === "folder" && !blocked.has(i.id));
	const pathOf = (f: LibraryItem) => [...libraryAncestors(allItems, f.id), f].map((x) => x.name).join(" / ");
	const alreadyIn = (parentId: string | null) => moving.every((m) => m.parentId === parentId);
	const title = moving.length === 1 ? `Move “${moving[0]!.name}” to…` : `Move ${moving.length} items to…`;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
			<div role="dialog" aria-modal="true" aria-label="Move items" onClick={(e) => e.stopPropagation()} className="flex max-h-[70vh] w-[28rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl">
				<h2 className="text-sm font-semibold">{title}</h2>
				<div className="mt-3 flex-1 overflow-y-auto rounded-lg border border-border/60 p-1">
					<button type="button" disabled={alreadyIn(null)} onClick={() => onMove(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40">
						<LibraryIcon aria-hidden="true" className="size-4" />
						Library (top level)
					</button>
					{folders
						.map((f) => ({ f, path: pathOf(f) }))
						.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }))
						.map(({ f, path }) => (
							<button key={f.id} type="button" disabled={alreadyIn(f.id)} onClick={() => onMove(f.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40">
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

function DeleteLibraryDialog({ targets, onClose, onDeleted }: { targets: LibraryItem[] | null; onClose: () => void; onDeleted: () => void }) {
	const [impact, setImpact] = useState<LibraryDeletionImpact | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdrop = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useEscape(targets !== null, onClose);
	useEffect(() => {
		setImpact(null);
		setFailure(null);
		setBusy(false);
		if (!targets || targets.length === 0) return;
		let live = true;
		// One combined warning: every removed id and every affected chat, once.
		Promise.all(targets.map((t) => deletionImpact(t.id)))
			.then((rs) => {
				if (!live) return;
				const chats = new Map<string, { id: string; title: string }>();
				for (const r of rs) for (const c of r.impact.chats) chats.set(c.id, c);
				setImpact({ itemIds: [...new Set(rs.flatMap((r) => r.impact.itemIds))], chats: [...chats.values()] });
			})
			.catch((e: unknown) => live && setFailure(e instanceof Error ? e.message : String(e)));
		return () => {
			live = false;
		};
	}, [targets]);
	if (!targets || targets.length === 0) return null;
	const run = async () => {
		setBusy(true);
		try {
			for (const t of targets) await deleteItem(t.id);
			onDeleted();
		} catch (e) {
			setFailure(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
			<DeleteLibraryBody items={targets} impact={impact} busy={busy} failure={failure} onClose={onClose} onRun={() => void run()} />
		</div>,
		document.body,
	);
}

/** The delete confirm's pure body (SSR pins). Lists the chats that use the
 *  items (owner ruling: warn, then detach). */
export function DeleteLibraryBody({
	items,
	impact,
	busy,
	failure,
	onClose,
	onRun,
}: {
	items: readonly Pick<LibraryItem, "name" | "kind">[];
	impact: LibraryDeletionImpact | null;
	busy: boolean;
	failure: string | null;
	onClose: () => void;
	onRun: () => void;
}) {
	const single = items.length === 1 ? items[0]! : null;
	const inside = impact ? impact.itemIds.length - items.length : 0;
	const title = single ? `Delete ${single.kind === "folder" ? "folder" : "file"}?` : `Delete ${items.length} items?`;
	return (
		<div role="dialog" aria-modal="true" aria-label="Delete library items" data-testid="library-delete-dialog" onClick={(e) => e.stopPropagation()} className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
			<h2 className="text-sm font-semibold text-destructive">{title}</h2>
			<div className="mt-1.5 flex flex-col">
				{items.slice(0, 8).map((i) => (
					<code key={i.name} className="truncate font-mono text-sm text-foreground">
						{i.name}
					</code>
				))}
				{items.length > 8 && <span className="text-xs text-muted-foreground">and {items.length - 8} more</span>}
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				{impact && inside > 0
					? `This permanently removes ${single ? "it" : "them"} and the ${inside} item${inside === 1 ? "" : "s"} inside from your library. `
					: `This permanently removes ${single ? "it" : "them"} from your library. `}
				Past messages that used {single ? "it" : "them"} stay as they are. This cannot be undone.
			</p>
			{impact === null && !failure && <p className="mt-3 text-xs text-muted-foreground">Checking which chats use {single ? "it" : "them"}…</p>}
			{impact && impact.chats.length > 0 && (
				<div className="mt-3 rounded-lg border border-border/60 px-3 py-2" data-testid="library-delete-chats">
					<p className="text-xs text-foreground">
						Used by {impact.chats.length} chat{impact.chats.length === 1 ? "" : "s"}. {single ? "It" : "They"} will be detached from:
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

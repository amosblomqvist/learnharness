"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { canMoveFolder, folderIsEmpty, fuzzyScore, placementOf, folderEntryCheck, type SourceEntrySelection, type OrganizationAction, type SourceDirectory } from "@/src/core";
import type { ChainSort } from "./chain-table";
import { chainRow } from "./chain-navigation";

export type OrganizationChange = (action: OrganizationAction) => Promise<string | void>;
const DRAG_TYPE = "application/x-learnharness-source";
const RowEditing = createContext<((editing: boolean) => void) | null>(null);

/** Keep the existing row as the drag surface, not the editor. A transient,
 * fixed-position preview carries only the icon/name, never the row's columns. */
export function SourceDragRow({ kind, id, name, enabled, children, ...props }: HTMLAttributes<HTMLDivElement> & {
	kind: "source" | "folder"; id: string; name: string; enabled: boolean; children: ReactNode;
}) {
	const [editing, setEditing] = useState(false);
	return <RowEditing.Provider value={setEditing}>
		<div {...props} data-source-drag-row={id} draggable={enabled && !editing}
			onDragStart={(event) => {
				if (!enabled || editing || (event.target as Element).closest('input:not([type="checkbox"]),textarea,[contenteditable="true"]')) { event.preventDefault(); return; }
				event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind, id }));
				event.dataTransfer.effectAllowed = "move";
				const preview = event.currentTarget.ownerDocument.createElement("div");
				preview.dataset.sourceDragPreview = "";
				preview.className = "pointer-events-none fixed z-50 flex w-max max-w-72 items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 py-1 text-sm font-medium text-foreground shadow-md";
				preview.style.left = `${event.clientX - 12}px`;
				preview.style.top = `${event.clientY - 12}px`;
				preview.style.fontFamily = getComputedStyle(event.currentTarget).fontFamily;
				const icon = event.currentTarget.querySelector("[data-source-icon] svg")?.cloneNode(true);
				if (icon) preview.appendChild(icon);
				const label = preview.ownerDocument.createElement("span");
				label.className = "truncate"; label.textContent = name; preview.appendChild(label);
				preview.ownerDocument.body.appendChild(preview);
				event.dataTransfer.setDragImage(preview, 12, 12);
				requestAnimationFrame(() => preview.remove());
			}}>{children}</div>
	</RowEditing.Provider>;
}

/** Source/folder names are also searchable, including sources without nodes. */
export function sourceNameMatches(directory: SourceDirectory | undefined, id: string, label: string | null, query: string): boolean {
	if (!query.trim()) return true;
	if (fuzzyScore(query, label ?? "") !== null) return true;
	if (!directory) return false;
	let parent = placementOf(directory.organization, id)?.folderId ?? null;
	const seen = new Set<string>();
	while (parent !== null && !seen.has(parent)) {
		seen.add(parent);
		const folder = directory.organization.folders.find((f) => f.id === parent);
		if (!folder) break;
		if (fuzzyScore(query, folder.name) !== null) return true;
		parent = folder.parentId;
	}
	return false;
}

/** Same Enter/blur commit and Escape cancel interaction as session titles.
 * The in-flight guard prevents Enter followed by blur from double-writing. */
export function EditableSourceName({ name, onSave, onCancel, initiallyEditing = false }: {
	name: string; onSave: (name: string) => Promise<unknown>; onCancel?: () => void; initiallyEditing?: boolean;
}) {
	const [editing, setEditing] = useState(initiallyEditing);
	const [draft, setDraft] = useState(name);
	const [failure, setFailure] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const submitting = useRef(false);
	const cancelled = useRef(false);
	const setRowEditing = useContext(RowEditing);
	useLayoutEffect(() => { setRowEditing?.(editing); return () => setRowEditing?.(false); }, [editing, setRowEditing]);
	useLayoutEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
	const commit = async () => {
		if (cancelled.current || submitting.current) return;
		const value = draft.trim();
		if (!value) { setEditing(false); onCancel?.(); return; }
		if (value === name && !initiallyEditing) { setEditing(false); return; }
		submitting.current = true;
		try { await onSave(value); setEditing(false); setFailure(""); }
		catch (error) { setFailure(error instanceof Error ? error.message : String(error)); input.current?.focus(); }
		finally { submitting.current = false; }
	};
	return <span className="min-w-0 flex-1">
		{editing ? <input ref={input} value={draft} placeholder="Folder name" aria-label="Source or folder name" data-testid="source-name-input"
			className="block h-5 w-full min-w-0 border-0 bg-transparent p-0 text-sm font-medium leading-5 outline-none shadow-none focus:ring-0"
			onChange={(e) => setDraft(e.target.value)} onBlur={() => { void commit(); }}
			onKeyDown={(e) => {
				if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditing(false); setFailure(""); onCancel?.(); }
				if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
			}} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }} />
			: <button type="button" className="block max-w-full truncate rounded-sm text-left text-sm font-medium leading-5 transition-colors hover:bg-accent" title="Rename"
				onClick={() => { cancelled.current = false; setDraft(name); setEditing(true); }}>{name}</button>}
		{failure && <span role="alert" className="block text-xs text-red-400">{failure}</span>}
	</span>;
}

interface TreeSource {
	key: string; birth: string | null; label: string | null; nodeIds: string[]; newestCreatedAt: string;
}
export function SourceFolderTree<T extends TreeSource>({ groups, directory, query, sort, renderSource, onAction, expanded,
	onToggleExpanded, selection, selectedFolders, onToggleNodes, onToggleFolder, allSourceNodes, allowEmptySelection = true, collapsedForSearch, sourceSelection }: {
	groups: T[]; directory?: SourceDirectory; query: string; sort: ChainSort;
	renderSource: (source: T, depth: number) => ReactNode;
	allSourceNodes?: ReadonlyMap<string, ReadonlySet<string>>;
	allowEmptySelection?: boolean;
	collapsedForSearch?: ReadonlySet<string>;
	sourceSelection?: SourceEntrySelection;
	onAction?: OrganizationChange; expanded: ReadonlySet<string>; onToggleExpanded: (id: string) => void;
	selection: ReadonlySet<string>; selectedFolders: ReadonlySet<string>;
	onToggleNodes: (ids: string[], next: boolean) => void; onToggleFolder: (id: string, next: boolean) => void;
}) {
	const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
	const [draggedItem, setDraggedItem] = useState<{ kind: "source" | "folder"; id: string }>();
	if (!directory) return <>{groups.map((g) => renderSource(g, 0))}</>;
	const state = directory.organization;
	const ids = new Set(directory.sources.map((s) => s.id));
	const search = query.trim() !== "";
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const parentOf = (g: Pick<T, "birth">) => g.birth === null ? null : placementOf(state, g.birth)?.folderId ?? null;
	const isDescendant = (g: Pick<T, "birth">, folderId: string): boolean => {
		let parent = parentOf(g);
		while (parent !== null) {
			if (parent === folderId) return true;
			parent = state.folders.find((f) => f.id === parent)?.parentId ?? null;
		}
		return false;
	};
	const nodeIds = (folderId: string) => [...new Set(allSourceNodes
		? [...allSourceNodes].filter(([birth]) => isDescendant({ birth }, folderId)).flatMap(([, nodes]) => [...nodes])
		: groups.filter((g) => isDescendant(g, folderId)).flatMap((g) => g.nodeIds))];
	const visibleFolder = (id: string): boolean => !search || groups.some((g) => isDescendant(g, id))
		|| state.folders.some((f) => f.id === id && fuzzyScore(query, f.name) !== null)
		|| state.folders.some((f) => f.parentId === id && visibleFolder(f.id));
	const dropProps = (parentId: string | null) => onAction ? {
		onDragOver(event: DragEvent) {
			if (!Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) return;
			event.preventDefault(); event.stopPropagation();
			const valid = draggedItem?.kind !== "folder" || canMoveFolder(state, draggedItem.id, parentId);
			event.dataTransfer.dropEffect = valid ? "move" : "none";
			setDropTarget(valid ? parentId : undefined);
		},
		onDragLeave(event: DragEvent) {
			if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
			event.stopPropagation();
			setDropTarget((previous) => previous === parentId ? undefined : previous);
		},
		onDrop(event: DragEvent) {
			const raw = event.dataTransfer.getData(DRAG_TYPE);
			if (!raw) return;
			event.preventDefault(); event.stopPropagation();
			setDropTarget(undefined); setDraggedItem(undefined);
			let item: { kind?: unknown; id?: unknown };
			try { item = JSON.parse(raw); } catch { return; }
			if (!item || typeof item !== "object") return;
			if ((item.kind !== "source" && item.kind !== "folder") || typeof item.id !== "string") return;
			if (item.kind === "folder" && !canMoveFolder(state, item.id, parentId)) return;
			void onAction({ action: "move", kind: item.kind, id: item.id, parentId }).catch(() => {});
		},
	} : {};
	const renderLevel = (parentId: string | null, depth: number): ReactNode => {
		const items = [
			...groups.filter((g) => parentOf(g) === parentId).map((g) => ({ kind: "source" as const, source: g, id: g.key, name: g.label ?? "\uffff", count: g.nodeIds.length, date: g.newestCreatedAt })),
			...state.folders.filter((f) => f.parentId === parentId && visibleFolder(f.id)).map((f) => ({ kind: "folder" as const, folder: f, id: f.id, name: f.name, count: nodeIds(f.id).length, date: f.createdAt })),
		];
		items.sort((a, b) => {
			const byName = collator.compare(a.name, b.name);
			return (sort.col === "name" ? byName : sort.col === "props" ? a.count - b.count : a.date.localeCompare(b.date)) * sort.dir || byName || a.id.localeCompare(b.id);
		});
		return items.map((item) => {
			if (item.kind === "source") return <div key={item.id} {...dropProps(parentId)}>{renderSource(item.source, depth)}</div>;
			const folder = item.folder;
			const open = search ? !collapsedForSearch?.has(folder.id) : expanded.has(folder.id);
			const members = nodeIds(folder.id);
			const empty = folderIsEmpty(state, folder.id, ids);
			const selectedCount = members.filter((id) => selection.has(id)).length;
			const entryCheck = sourceSelection ? folderEntryCheck(directory, folder.id, sourceSelection) : undefined;
			const hasChildren = state.folders.some((f) => f.parentId === folder.id && visibleFolder(f.id)) || groups.some((g) => parentOf(g) === folder.id);
			return <div key={folder.id} data-testid={`source-folder-${folder.id}`} className="relative" {...dropProps(folder.id)}>
				<SourceDragRow {...chainRow(["folder", folder.id], depth, open)} kind="folder" id={folder.id} name={folder.name} enabled={Boolean(onAction)} data-testid={`folder-row-${folder.id}`}
					data-drop-active={dropTarget === folder.id}
					className={`flex items-center gap-1 py-1.5 pr-3 transition-colors ${!open || !hasChildren ? "border-b border-transparent" : ""} ${dropTarget === folder.id ? "bg-accent/50" : ""}`}
					style={{ paddingLeft: 12 + depth * 36 }}>
					<input type="checkbox" aria-label={`Select ${sourceSelection ? "folder" : "contents of"} ${folder.name}`} data-testid={`folder-checkbox-${folder.id}`}
						className="size-3.5 shrink-0 accent-primary" disabled={entryCheck ? false : empty ? !allowEmptySelection : members.length === 0}
						checked={entryCheck?.checked ?? (empty ? selectedFolders.has(folder.id) : members.length > 0 && selectedCount === members.length)}
						ref={(el) => { if (el) el.indeterminate = entryCheck?.indeterminate ?? (!empty && selectedCount > 0 && selectedCount < members.length); }}
						onChange={(e) => { if (entryCheck || empty) onToggleFolder(folder.id, e.target.checked); else onToggleNodes(members, e.target.checked); }} />
					<button type="button" aria-expanded={open} aria-label={`Expand folder ${folder.name}`} data-testid={`folder-toggle-${folder.id}`}
						onClick={() => onToggleExpanded(folder.id)} className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
						<ChevronRightIcon className={`size-3.5 ${open ? "rotate-90" : ""}`} />
					</button>
					<button type="button" data-source-icon data-testid={`folder-icon-${folder.id}`} aria-expanded={open} aria-label={`Expand folder ${folder.name}`}
						onClick={() => onToggleExpanded(folder.id)} className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						{open ? <FolderOpenIcon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
					</button>
					{onAction ? <EditableSourceName name={folder.name} onSave={(name) => onAction({ action: "rename-folder", id: folder.id, name })} />
						: <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>}
					<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{members.length}</span>
					<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{folder.createdAt.slice(0, 10)}</span>
				</SourceDragRow>
				{open && hasChildren && <div data-testid={`folder-thread-${folder.id}`} className="pointer-events-none absolute bottom-[8px] top-[23px] w-px bg-border/50" style={{ left: 37 + depth * 36 }} />}
				{open && renderLevel(folder.id, depth + 1)}
				<div data-testid={`folder-separator-${folder.id}`} className="pointer-events-none absolute bottom-0 right-0 border-b border-border/60" style={{ left: depth === 0 ? 0 : depth * 36 + 1 }} />
			</div>;
		});
	};
	return <div className="flex flex-1 flex-col" onDragStart={(event) => {
		try {
			const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
			if (item && (item.kind === "source" || item.kind === "folder") && typeof item.id === "string") setDraggedItem(item);
		} catch { /* An unrelated native text/file drag is not an organization move. */ }
	}} onDragEnd={() => { setDropTarget(undefined); setDraggedItem(undefined); }}>
		<div>{renderLevel(null, 0)}</div>
		{onAction && <div data-testid="source-root-drop" aria-label="Move outside folders" data-drop-active={dropTarget === null}
			className={`min-h-16 flex-1 transition-colors ${dropTarget === null ? "bg-accent/30" : ""}`} {...dropProps(null)} />}
	</div>;
}

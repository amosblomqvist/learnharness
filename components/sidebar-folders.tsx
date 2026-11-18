"use client";

import { useCallback, useEffect, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { canMoveFolder, type OrganizationAction, type SourceFolder, type SourceOrganization } from "@/src/core";
import { EditableSourceName, SOURCE_DRAG_TYPE, SourceDragRow } from "@/components/source-folder-tree";
import { cn } from "@/lib/utils";

/**
 * Session-sidebar folders (approved plan): the shared source organization
 * shown as a compact Chains-style tree. Clicking a folder row only opens or
 * closes it; right-click opens the folder menu (owned by the sidebar);
 * dragging reuses the Chains source/folder drag payload.
 */

/** Indent per tree level: the chevron (14px) + its gap (4px), so a child
 * starts under its parent's folder icon — Chains' alignment rule without its
 * checkbox column. */
export const SIDEBAR_TREE_INDENT = 18;
export const sidebarRowPadding = (depth: number) => 12 + depth * SIDEBAR_TREE_INDENT;
/** The rail's x: the centre of a folder row's chevron at `depth`. */
export const sidebarRail = (depth: number) => sidebarRowPadding(depth) + 7;
/** Where a row's bottom rule starts (Chains' rule): full width at the top
 * level, from the parent folder's rail inside folders. */
export const sidebarRuleInset = (depth: number) => depth === 0 ? 0 : sidebarRail(depth - 1);
/** Rows inside folders START at the parent's rail (Chains' source rows), so
 * their rules, hover and active highlights never cover a rail. */
export const sidebarRowBox = (depth: number) => ({ marginLeft: sidebarRuleInset(depth), paddingLeft: sidebarRowPadding(depth) - sidebarRuleInset(depth) });

/** Reserves each row's 1px rule slot. Inline on purpose: the unlayered
 * global `* { border-color }` rule outranks Tailwind's transparent border. */
export const RULE_SLOT = { borderBottom: "1px solid transparent" } as const;

/** A horizontal rule in its row's (transparent) bottom border pixel. */
export function SidebarRule({ inset, testid }: { inset: number; testid?: string }) {
	return <div aria-hidden="true" data-testid={testid} className="pointer-events-none absolute bottom-[-1px] right-0 border-b border-border/60" style={{ left: inset }} />;
}

const OPEN_FOLDERS_KEY = "lh:sidebar-open-folders";

/** The sidebar's own open/closed folders, remembered on this device. */
export function useOpenFolders() {
	const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		try {
			const raw: unknown = JSON.parse(window.localStorage.getItem(OPEN_FOLDERS_KEY) ?? "[]");
			if (Array.isArray(raw)) setOpenFolders(new Set(raw.filter((id): id is string => typeof id === "string")));
		} catch { /* a corrupt value means nothing remembered */ }
	}, []);
	const setOpen = useCallback((id: string, open: boolean) => {
		setOpenFolders((previous) => {
			if (previous.has(id) === open) return previous;
			const next = new Set(previous);
			if (open) next.add(id); else next.delete(id);
			try { window.localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...next])); } catch { /* storage full/denied */ }
			return next;
		});
	}, []);
	return { openFolders, setOpen };
}

/** Drop targets for sessions and folders: a folder, a row inside a folder
 * (its folder), or the empty area below the list (out of all folders). */
export function useSidebarDrop(organization: SourceOrganization | undefined, change: (action: OrganizationAction) => Promise<unknown>) {
	const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
	const [dragged, setDragged] = useState<{ kind: "source" | "folder"; id: string }>();
	const dropProps = (parentId: string | null) => organization ? {
		onDragOver(event: DragEvent) {
			if (!Array.from(event.dataTransfer.types).includes(SOURCE_DRAG_TYPE)) return;
			event.preventDefault(); event.stopPropagation();
			const valid = dragged?.kind !== "folder" || canMoveFolder(organization, dragged.id, parentId);
			event.dataTransfer.dropEffect = valid ? "move" : "none";
			setDropTarget(valid ? parentId : undefined);
		},
		onDragLeave(event: DragEvent) {
			if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
			event.stopPropagation();
			setDropTarget((previous) => previous === parentId ? undefined : previous);
		},
		onDrop(event: DragEvent) {
			const raw = event.dataTransfer.getData(SOURCE_DRAG_TYPE);
			if (!raw) return;
			event.preventDefault(); event.stopPropagation();
			setDropTarget(undefined); setDragged(undefined);
			let item: { kind?: unknown; id?: unknown };
			try { item = JSON.parse(raw); } catch { return; }
			if (!item || typeof item !== "object" || (item.kind !== "source" && item.kind !== "folder") || typeof item.id !== "string") return;
			if (item.kind === "folder" && !canMoveFolder(organization, item.id, parentId)) return;
			void change({ action: "move", kind: item.kind, id: item.id, parentId }).catch(() => {});
		},
	} : {};
	const containerProps = {
		onDragStart(event: DragEvent) {
			try {
				const item = JSON.parse(event.dataTransfer.getData(SOURCE_DRAG_TYPE));
				if (item && (item.kind === "source" || item.kind === "folder") && typeof item.id === "string") setDragged(item);
			} catch { /* an unrelated drag is not an organization move */ }
		},
		onDragEnd() { setDropTarget(undefined); setDragged(undefined); },
	};
	return { dropTarget, dropProps, containerProps };
}

export function SidebarFolderRow({ folder, depth, open, contentsShown, dropActive, renaming, onToggle, onContextMenu, onRename, onRenameDone, draggable }: {
	folder: SourceFolder; depth: number; open: boolean; dropActive: boolean; renaming: boolean; draggable: boolean;
	/** Open with visible contents: the row's rule heads them from the rail. */
	contentsShown: boolean;
	onToggle: () => void;
	onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
	onRename: (name: string) => Promise<unknown>;
	onRenameDone: () => void;
}) {
	const Icon = open ? FolderOpenIcon : FolderIcon;
	return (
		<SourceDragRow kind="folder" id={folder.id} name={folder.name} enabled={draggable && !renaming}
			data-testid={`sidebar-folder-row-${folder.id}`} data-drop-active={dropActive}
			style={{ ...RULE_SLOT, marginLeft: sidebarRowBox(depth).marginLeft }} className={cn("relative transition-colors", dropActive && "bg-accent/50")}>
			<SidebarRule testid={`sidebar-folder-rule-${folder.id}`} inset={contentsShown ? sidebarRail(depth) - sidebarRuleInset(depth) : 0} />
			{renaming ? (
				<div className="flex w-full items-center gap-1 py-1.5 pr-3" style={{ paddingLeft: sidebarRowBox(depth).paddingLeft }}>
					<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground/70", open && "rotate-90")} />
					<Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
					<EditableSourceName name={folder.name} initiallyEditing onCancel={onRenameDone}
						onSave={async (name) => { if (name !== folder.name) await onRename(name); onRenameDone(); }} />
				</div>
			) : (
				<button type="button" data-testid={`sidebar-folder-${folder.id}`} aria-expanded={open}
					aria-label={`${open ? "Collapse" : "Expand"} folder ${folder.name}`}
					onClick={onToggle} onContextMenu={onContextMenu}
					className="flex w-full items-center gap-1 py-1.5 pr-3 text-left transition-colors hover:bg-accent"
					style={{ paddingLeft: sidebarRowBox(depth).paddingLeft }}>
					<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground/70", open && "rotate-90")} />
					<Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate font-ui text-sm font-medium leading-5">{folder.name}</span>
				</button>
			)}
		</SourceDragRow>
	);
}

/** The inline new-folder row (Add folder / New subfolder). */
export function NewFolderRow({ depth, onCreate, onDone }: { depth: number; onCreate: (name: string) => Promise<unknown>; onDone: () => void }) {
	return (
		<div data-testid="sidebar-new-folder-row" className="relative flex w-full items-center gap-1 py-1.5 pr-3" style={{ ...RULE_SLOT, ...sidebarRowBox(depth) }}>
			<SidebarRule inset={0} />
			<span aria-hidden="true" className="size-3.5 shrink-0" />
			<FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
			<EditableSourceName name="" initiallyEditing onCancel={onDone} onSave={async (name) => { await onCreate(name); onDone(); }} />
		</div>
	);
}

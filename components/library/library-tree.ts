import { folderEntries, isInLibrarySubtree, librarySubtree, placementOf, type LibraryItem, type SourceDirectory, type SourceEntrySelection } from "@/src/core";

/**
 * THE LIBRARY ↔ SOURCE-TREE ADAPTER (owner ruling 2026-11-03: the Library
 * page reuses main's SourceFolderTree as-is). Library folders become the
 * tree's folders, library files its "sources", and each file's parent its
 * placement. Every file carries itself as its one "node", so the tree's
 * count column reads as files-under-this-folder. Pure — render pins cover it.
 */

/** One library file as a tree "source" (the TreeSource shape + the item). */
export interface LibraryTreeFile {
	key: string;
	birth: string;
	label: string;
	nodeIds: string[];
	newestCreatedAt: string;
	item: LibraryItem;
}

export function libraryDirectory(items: readonly LibraryItem[]): SourceDirectory {
	const files = items.filter((i) => i.kind === "file");
	return {
		organization: {
			version: 1,
			folders: items
				.filter((i) => i.kind === "folder")
				.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, createdAt: f.createdAt })),
			placements: Object.fromEntries(files.map((f) => [f.id, { folderId: f.parentId }])),
		},
		sources: files.map((f) => ({ id: f.id, kind: "notes" as const, label: f.name, createdAt: f.createdAt })),
	};
}

export function libraryTreeFiles(items: readonly LibraryItem[]): LibraryTreeFile[] {
	return items
		.filter((i) => i.kind === "file")
		.map((f) => ({ key: f.id, birth: f.id, label: f.name, nodeIds: [f.id], newestCreatedAt: f.createdAt, item: f }));
}

export const EMPTY_SELECTION: SourceEntrySelection = { sources: new Set(), folders: new Set() };

/** The Library page's check/uncheck (owner ruling 2026-11-03). Unlike
 *  main's toggleSourceEntries, folders are never checked from below:
 *  checking a file selects just it; checking a folder selects its whole
 *  subtree. Unchecking removes the entry (and a folder's subtree) and every
 *  folder above it, so Move/Delete never act on a folder you excluded
 *  something from. */
export function toggleLibraryEntries(
	directory: SourceDirectory,
	selected: SourceEntrySelection,
	kind: "source" | "folder",
	id: string,
	checked: boolean,
): SourceEntrySelection {
	const sources = new Set(selected.sources), folders = new Set(selected.folders);
	const entries = kind === "source" ? { sources: [id], folders: [] as string[] } : folderEntries(directory, id);
	for (const s of entries.sources) { if (checked) sources.add(s); else sources.delete(s); }
	for (const f of entries.folders) { if (checked) folders.add(f); else folders.delete(f); }
	if (!checked) {
		const org = directory.organization;
		let parent = kind === "source" ? placementOf(org, id)?.folderId ?? null : org.folders.find((f) => f.id === id)?.parentId ?? null;
		const seen = new Set<string>();
		while (parent !== null && !seen.has(parent)) {
			seen.add(parent);
			folders.delete(parent);
			parent = org.folders.find((f) => f.id === parent)?.parentId ?? null;
		}
	}
	return { sources, folders };
}

/** One visible tree row, in on-screen order (files are "source" rows). */
export interface TreeRow {
	kind: "source" | "folder";
	id: string;
}

/** Just this entry (a folder with its whole subtree). */
export function onlySelection(directory: SourceDirectory, kind: TreeRow["kind"], id: string): SourceEntrySelection {
	return toggleLibraryEntries(directory, EMPTY_SELECTION, kind, id, true);
}

export function isRowSelected(selection: SourceEntrySelection, kind: TreeRow["kind"], id: string): boolean {
	return kind === "source" ? selection.sources.has(id) : selection.folders.has(id);
}

/** Cmd/Ctrl-click and Space: add the entry, or remove it if selected. */
export function toggleRowSelection(directory: SourceDirectory, current: SourceEntrySelection, kind: TreeRow["kind"], id: string): SourceEntrySelection {
	return toggleLibraryEntries(directory, current, kind, id, !isRowSelected(current, kind, id));
}

/** Every given row selected, folders with their subtrees (Cmd/Ctrl+A). */
export function unionSelection(directory: SourceDirectory, rows: readonly TreeRow[]): SourceEntrySelection {
	let selection = EMPTY_SELECTION;
	for (const row of rows) selection = toggleLibraryEntries(directory, selection, row.kind, row.id, true);
	return selection;
}

/** The rows from the anchor to the target, inclusive, in on-screen order;
 *  empty when either is not visible. */
export function rowRange(rows: readonly TreeRow[], anchorId: string, targetId: string): TreeRow[] {
	const a = rows.findIndex((r) => r.id === anchorId), b = rows.findIndex((r) => r.id === targetId);
	return a < 0 || b < 0 ? [] : rows.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** What a key does in the Library tree (Finder-style, owner ruling
 *  2026-11-03). `rows` are the visible rows in order; `current` the focused
 *  row's index (-1 when the tree itself has focus). */
export type TreeKeyAction =
	| { type: "select"; row: TreeRow; mode: "move" | "range" | "toggle" }
	| { type: "expand"; id: string }
	| { type: "open"; id: string }
	| { type: "clear" }
	| { type: "select-all" };
export function treeKeyAction(
	rows: readonly TreeRow[],
	current: number,
	key: { key: string; shift: boolean; mod: boolean; alt: boolean; onControl: boolean },
	state: { expanded: (id: string) => boolean; parentOf: (id: string) => string | null; hasSelection: boolean },
): TreeKeyAction | null {
	const row = rows[current];
	if (rows.length === 0) return null;
	switch (key.key) {
		case "ArrowDown":
		case "ArrowUp": {
			if (key.mod || key.alt) return null;
			const step = key.key === "ArrowDown" ? 1 : -1;
			const next = rows[current < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, current + step))]!;
			return { type: "select", row: next, mode: key.shift ? "range" : "move" };
		}
		case "ArrowRight":
			if (!row || key.mod || key.shift || key.alt) return null;
			return row.kind === "folder" && !state.expanded(row.id) ? { type: "expand", id: row.id } : null;
		case "ArrowLeft": {
			if (!row || key.mod || key.shift || key.alt) return null;
			if (row.kind === "folder" && state.expanded(row.id)) return { type: "expand", id: row.id };
			const parent = state.parentOf(row.id);
			return parent ? { type: "select", row: { kind: "folder", id: parent }, mode: "move" } : null;
		}
		case " ":
			if (!row || key.onControl || key.mod || key.shift || key.alt) return null;
			return { type: "select", row, mode: "toggle" };
		case "Enter":
			if (!row || key.onControl || key.mod || key.shift || key.alt) return null;
			return row.kind === "folder" ? { type: "expand", id: row.id } : { type: "open", id: row.id };
		case "Escape":
			return state.hasSelection ? { type: "clear" } : null;
		case "a":
		case "A":
			return key.mod && !key.shift && !key.alt ? { type: "select-all" } : null;
		default:
			return null;
	}
}

/** A row click (not its checkbox) selects only that entry — a folder brings
 *  its subtree, exactly as checking it would from nothing. Clicking the row
 *  that is already the whole selection clears it. */
export function rowClickSelection(
	directory: SourceDirectory,
	current: SourceEntrySelection,
	kind: "source" | "folder",
	id: string,
): SourceEntrySelection {
	const only = onlySelection(directory, kind, id);
	const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
	return same(only.sources, current.sources) && same(only.folders, current.folders) ? EMPTY_SELECTION : only;
}

/** Drop ids that no longer exist (deleted elsewhere, or by this page). */
export function pruneSelection(items: readonly LibraryItem[], selection: SourceEntrySelection): SourceEntrySelection {
	const ids = new Set(items.map((i) => i.id));
	const sources = [...selection.sources].filter((id) => ids.has(id));
	const folders = [...selection.folders].filter((id) => ids.has(id));
	if (sources.length === selection.sources.size && folders.length === selection.folders.size) return selection;
	return { sources: new Set(sources), folders: new Set(folders) };
}

/** The checked items no checked folder already covers: a checked folder
 *  stands for its whole subtree (Move and Delete act on these). */
export function topMostSelected(items: readonly LibraryItem[], selection: SourceEntrySelection): LibraryItem[] {
	const checked = new Set([...selection.sources, ...selection.folders]);
	return items.filter((i) => checked.has(i.id) && !(i.parentId !== null && selection.folders.has(i.parentId)));
}

/** The one folder YOU checked that is a target (Upload, New folder), else
 *  null — the top level. Main's selection also checks a parent once all its
 *  children are checked, so the auto-checked parent must not win: `picked`
 *  holds the folders the user clicked. "One" means exactly one picked folder
 *  still checked (ignoring picked folders inside it) and no checked file
 *  outside it. */
export function singleCheckedFolder(
	items: readonly LibraryItem[],
	selection: SourceEntrySelection,
	picked: ReadonlySet<string>,
): string | null {
	const live = [...picked].filter((id) => selection.folders.has(id));
	const outer = live.filter((id) => !live.some((other) => other !== id && isInLibrarySubtree(items, other, id)));
	if (outer.length !== 1) return null;
	const folder = outer[0]!;
	const inside = new Set(librarySubtree(items, folder).map((i) => i.id));
	return [...selection.sources].every((id) => inside.has(id)) ? folder : null;
}

import { isInLibrarySubtree, librarySubtree, type LibraryItem, type SourceDirectory, type SourceEntrySelection } from "@/src/core";

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

import { placementOf, type SourceDirectory } from "./source-organization.ts";

export interface SourceEntrySelection { sources: ReadonlySet<string>; folders: ReadonlySet<string> }
export function folderEntries(directory: SourceDirectory, id: string): { sources: string[]; folders: string[] } {
	const folders = new Set([id]);
	for (const folder of directory.organization.folders) {
		let parent = folder.parentId;
		const seen = new Set<string>();
		while (parent !== null && !seen.has(parent)) {
			if (parent === id) { folders.add(folder.id); break; }
			seen.add(parent); parent = directory.organization.folders.find((f) => f.id === parent)?.parentId ?? null;
		}
	}
	return { folders: [...folders], sources: directory.sources.filter((s) => folders.has(placementOf(directory.organization, s.id)?.folderId ?? "")).map((s) => s.id) };
}
export function folderEntryCheck(directory: SourceDirectory, id: string, selected: SourceEntrySelection) {
	const entries = folderEntries(directory, id);
	const count = entries.sources.filter((id) => selected.sources.has(id)).length + entries.folders.filter((id) => selected.folders.has(id)).length;
	const total = entries.sources.length + entries.folders.length;
	return { checked: count === total, indeterminate: count > 0 && count < total };
}
/** One ordinary tree selection, independent of shared global graph-node IDs.
 * Empty entries count too; practice continues using its separate flat node set. */
export function toggleSourceEntries(directory: SourceDirectory, selected: SourceEntrySelection, kind: "source" | "folder", id: string, checked: boolean): SourceEntrySelection {
	const sources = new Set(selected.sources), folders = new Set(selected.folders);
	const apply = (set: Set<string>, ids: string[]) => { for (const id of ids) { if (checked) set.add(id); else set.delete(id); } };
	if (kind === "source") apply(sources, [id]);
	else { const entries = folderEntries(directory, id); apply(sources, entries.sources); apply(folders, entries.folders); }
	const depth = (id: string) => {
		let depth = 0, parent = directory.organization.folders.find((f) => f.id === id)?.parentId;
		const seen = new Set<string>();
		while (parent && !seen.has(parent)) { seen.add(parent); depth++; parent = directory.organization.folders.find((f) => f.id === parent)?.parentId; }
		return depth;
	};
	for (const folder of [...directory.organization.folders].sort((a, b) => depth(b.id) - depth(a.id))) {
		const childFolders = directory.organization.folders.filter((f) => f.parentId === folder.id);
		const childSources = directory.sources.filter((s) => placementOf(directory.organization, s.id)?.folderId === folder.id);
		if (!childFolders.length && !childSources.length) continue; // empty folders are real selectable entries
		if (childFolders.every((f) => folders.has(f.id)) && childSources.every((s) => sources.has(s.id))) folders.add(folder.id);
		else folders.delete(folder.id);
	}
	return { sources, folders };
}

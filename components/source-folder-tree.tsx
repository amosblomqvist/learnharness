"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, TagIcon } from "lucide-react";
import {
	folderEntries, folderEntryCheck, fuzzyScore, placementOf, tagSourceIds, untaggedSourceIds,
	type SourceEntrySelection, type SourceDirectory,
} from "@/src/core";
import type { ChainSort } from "./chain-table";
import { chainRow } from "./chain-navigation";
import { TagMark } from "./tag-picker";

/** Search the same tag memberships and ancestor folders shown in the library. */
export function sourceNameMatches(directory: SourceDirectory | undefined, id: string, label: string | null, query: string): boolean {
	if (!query.trim() || fuzzyScore(query, label ?? "") !== null) return true;
	if (!directory) return false;
	const state = directory.organization;
	const tagIds = new Set(placementOf(state, id)?.tagIds);
	for (const tag of state.tags ?? []) {
		if (!tagIds.has(tag.id)) continue;
		if (fuzzyScore(query, tag.name) !== null) return true;
		const seen = new Set<string>();
		for (let parent = tag.parentId; parent !== null && !seen.has(parent);) {
			seen.add(parent);
			const folder = state.folders.find(f => f.id === parent);
			if (!folder) break;
			if (fuzzyScore(query, folder.name) !== null) return true;
			parent = folder.parentId;
		}
	}
	return false;
}

interface TreeSource {
	key: string; birth: string | null; label: string | null; nodeIds: string[]; newestCreatedAt: string;
}
export function SourceFolderTree<T extends TreeSource>({ groups, directory, query, sort, renderSource, expanded,
	onToggleExpanded, selection, onToggleNodes, onToggleFolder, onToggleTag, onToggleUntagged,
	allSourceNodes, allowEmptySelection = true, collapsedForSearch, sourceSelection }: {
	groups: T[]; directory?: SourceDirectory; query: string; sort: ChainSort;
	renderSource: (source: T, depth: number, path: string[]) => ReactNode;
	allSourceNodes?: ReadonlyMap<string, ReadonlySet<string>>;
	allowEmptySelection?: boolean;
	collapsedForSearch?: ReadonlySet<string>;
	sourceSelection?: SourceEntrySelection;
	expanded: ReadonlySet<string>; onToggleExpanded: (id: string) => void;
	selection: ReadonlySet<string>;
	onToggleNodes: (ids: string[], next: boolean) => void; onToggleFolder: (id: string, next: boolean) => void;
	onToggleTag: (id: string, next: boolean) => void; onToggleUntagged: (next: boolean) => void;
}) {
	if (!directory) return <>{groups.map(g => renderSource(g, 0, []))}</>;
	const state = directory.organization;
	const search = query.trim() !== "";
	const tags = state.tags ?? [];
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const tagGroups = (id: string) => groups.filter(g => g.birth !== null && placementOf(state, g.birth)?.tagIds?.includes(id));
	const tagVisible = (id: string, name: string) => !search || tagGroups(id).length > 0 || fuzzyScore(query, name) !== null;
	const folderVisible = (id: string): boolean => !search || state.folders.some(f => f.id === id && fuzzyScore(query, f.name) !== null)
		|| tags.some(t => t.parentId === id && tagVisible(t.id, t.name))
		|| state.folders.some(f => f.parentId === id && folderVisible(f.id));
	const nodesFor = (sourceIds: string[]) => [...new Set(sourceIds.flatMap(id =>
		allSourceNodes ? [...(allSourceNodes.get(id) ?? [])] : groups.filter(g => g.birth === id).flatMap(g => g.nodeIds)))];
	const openFor = (key: string) => search ? !collapsedForSearch?.has(key) : expanded.has(key);
	function header({ kind, id, name, label, depth, open, members, sourceIds, date, toggle, children }: {
		kind: "folder" | "tag" | "untagged"; id: string; name: string; label: ReactNode; depth: number; open: boolean;
		members: string[]; sourceIds: string[]; date: string; toggle: (next: boolean) => void; children: ReactNode;
	}) {
		const key = kind === "folder" ? id : JSON.stringify([kind, id]);
		const count = sourceSelection ? sourceIds.filter(s => sourceSelection.sources.has(s)).length : members.filter(n => selection.has(n)).length;
		const total = sourceSelection ? sourceIds.length : members.length;
		const check = kind === "folder" && sourceSelection ? folderEntryCheck(directory!, id, sourceSelection)
			: { checked: total > 0 && count === total, indeterminate: count > 0 && count < total };
		const disabled = sourceSelection ? kind !== "folder" && total === 0 : members.length === 0;
		const hasChildren = Array.isArray(children) ? children.length > 0 : children !== null;
		return <div key={key} className="relative" data-testid={`${kind === "folder" ? "source-folder" : "source-tag"}-${id}`}>
			<div {...chainRow([kind, id], depth, open)} data-testid={`${kind}-row-${id}`}
				className="flex items-center gap-1 py-1.5 pr-3" style={{ paddingLeft: 12 + depth * 36 }}>
				<input type="checkbox" aria-label={`Select ${sourceSelection ? kind : "contents of"} ${name}`} data-testid={`${kind}-checkbox-${id}`}
					className="size-3.5 shrink-0 accent-primary" disabled={disabled || (!allowEmptySelection && total === 0)}
					checked={check.checked} ref={el => { if (el) el.indeterminate = check.indeterminate; }}
					onChange={e => { if (sourceSelection) toggle(e.target.checked); else onToggleNodes(members, e.target.checked); }} />
				<button type="button" aria-expanded={open} aria-label={`Expand ${kind} ${name}`} data-testid={`${kind}-toggle-${id}`}
					onClick={() => onToggleExpanded(key)} className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
					<ChevronRightIcon className={`size-3.5 ${open ? "rotate-90" : ""}`} />
				</button>
				<button type="button" data-source-icon data-testid={`${kind}-icon-${id}`} aria-expanded={open} aria-label={`Expand ${kind} ${name}`}
					onClick={() => onToggleExpanded(key)} className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent">
					{kind === "folder" ? open ? <FolderOpenIcon className="size-3.5" /> : <FolderIcon className="size-3.5" /> : <TagIcon className="size-3.5" />}
				</button>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
				<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{members.length}</span>
				<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{date.slice(0, 10)}</span>
			</div>
			{open && hasChildren && <div data-testid={`${kind}-thread-${id}`} className="pointer-events-none absolute bottom-[8px] top-[23px] w-px bg-border/50" style={{ left: 37 + depth * 36 }} />}
			{open && children}
		</div>;
	}
	const renderLevel = (parentId: string | null, depth: number): ReactNode => {
		const entries = [
			...state.folders.filter(f => f.parentId === parentId && folderVisible(f.id)).map(folder => ({
				kind: "folder" as const, id: folder.id, name: folder.name, date: folder.createdAt,
				sources: folderEntries(directory, folder.id).sources, tag: undefined,
			})),
			...tags.filter(t => t.parentId === parentId && tagVisible(t.id, t.name)).map(tag => ({
				kind: "tag" as const, id: tag.id, name: tag.name,
				date: tagGroups(tag.id).reduce((latest, g) => latest > g.newestCreatedAt ? latest : g.newestCreatedAt, ""),
				sources: tagSourceIds(directory, tag.id), tag,
			})),
		].map(entry => ({ ...entry, nodes: nodesFor(entry.sources) }));
		entries.sort((a, b) => (sort.col === "name" ? collator.compare(a.name, b.name)
			: sort.col === "props" ? a.nodes.length - b.nodes.length : a.date.localeCompare(b.date)) * sort.dir || collator.compare(a.name, b.name));
		return entries.map(entry => header({
			kind: entry.kind, id: entry.id, name: entry.name, label: entry.tag ? <TagMark tag={entry.tag} /> : entry.name,
			depth, open: openFor(entry.kind === "folder" ? entry.id : JSON.stringify(["tag", entry.id])),
			members: entry.nodes, sourceIds: entry.sources, date: entry.date,
			toggle: next => entry.kind === "folder" ? onToggleFolder(entry.id, next) : onToggleTag(entry.id, next),
			children: entry.kind === "folder" ? renderLevel(entry.id, depth + 1)
				: tagGroups(entry.id).map(g => renderSource(g, depth + 1, ["tag", entry.id])),
		}));
	};
	const untagged = groups.filter(g => g.birth === null || !placementOf(state, g.birth)?.tagIds?.length);
	const untaggedIds = untaggedSourceIds(directory);
	return <>{renderLevel(null, 0)}{untagged.length > 0 && header({
		kind: "untagged", id: "untagged", name: "Untagged", label: "Untagged", depth: 0,
		open: openFor(JSON.stringify(["untagged", "untagged"])),
		members: [...new Set([...nodesFor(untaggedIds), ...untagged.filter(g => g.birth === null).flatMap(g => g.nodeIds)])],
		sourceIds: untaggedIds, date: "", toggle: onToggleUntagged,
		children: untagged.map(g => renderSource(g, 1, ["untagged"])),
	})}<div data-testid="chain-table-blank-space" className="min-h-8 flex-1" /></>;
}

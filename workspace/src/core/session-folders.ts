import { fuzzyScore } from "./fuzzy.ts";
import { placementOf, type SourceDirectory, type SourceFolder, type SourceOrganization } from "./source-organization.ts";

/**
 * Session-sidebar and graph views over the ONE shared source organization
 * (folders + source placements; core/source-organization.ts). Pure and
 * browser-safe: these only read the organization, never write it. Each view
 * decides which sources it shows; the organization itself stays upstream.
 */

export interface SidebarSession {
	id: string;
	title: string;
	updatedAt: string;
}

export type SessionTreeNode<T extends SidebarSession> =
	| { type: "session"; session: T; score: number }
	| { type: "folder"; folder: SourceFolder; children: SessionTreeNode<T>[]; activity: string | null; score: number };

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * The sidebar's folder tree (approved plan):
 * - sessions sit in their placed folder; unknown/absent placements are unfiled;
 * - folders always sit above sessions at every level (owner, polish round);
 * - outside search, folders order by recent activity (a folder's activity is
 *   its newest visible session, subfolders included), folders without visible
 *   sessions follow A–Z after them; sessions order by recent activity;
 * - while searching, folders still lead; within the folders and within the
 *   sessions each level ranks by best match score (activity breaks ties);
 * - while searching, folders without matching sessions are hidden;
 * - otherwise folders holding no sessions at all show under every type
 *   filter (owner, 2026-11-18); a folder whose sessions the type filter
 *   (`include`) hides is hidden, unless it still leads to a shown folder.
 * `sessions` is every session; `include` is the existing type filter;
 * `query` scores titles exactly like the flat list did.
 */
export function buildSessionTree<T extends SidebarSession>(
	sessions: readonly T[],
	organization: SourceOrganization | undefined,
	options: { query: string; include?: (session: T) => boolean },
): SessionTreeNode<T>[] {
	const query = options.query.trim();
	const folders = organization?.folders ?? [];
	const folderIds = new Set(folders.map((f) => f.id));
	const sessionsByFolder = new Map<string | null, SessionTreeNode<T>[]>();
	const occupied = new Set<string>(); // folders directly holding any session
	for (const session of sessions) {
		const placed = organization ? placementOf(organization, session.id)?.folderId ?? null : null;
		const parent = placed !== null && folderIds.has(placed) ? placed : null;
		if (parent !== null) occupied.add(parent);
		if (options.include && !options.include(session)) continue;
		const score = query ? fuzzyScore(query, session.title) : 0;
		if (score === null) continue;
		const list = sessionsByFolder.get(parent) ?? [];
		list.push({ type: "session", session, score });
		sessionsByFolder.set(parent, list);
	}
	const activityOf = (node: SessionTreeNode<T>) => node.type === "session" ? node.session.updatedAt : node.activity;
	const nameOf = (node: SessionTreeNode<T>) => node.type === "session" ? node.session.title : node.folder.name;
	const idOf = (node: SessionTreeNode<T>) => node.type === "session" ? node.session.id : node.folder.id;
	const compare = (a: SessionTreeNode<T>, b: SessionTreeNode<T>): number => {
		if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
		const aa = activityOf(a), ba = activityOf(b);
		// Folders without visible sessions follow the other folders, A–Z.
		if (aa === null || ba === null) {
			if (aa !== ba) return aa === null ? 1 : -1;
			return collator.compare(nameOf(a), nameOf(b)) || idOf(a).localeCompare(idOf(b));
		}
		if (query && a.score !== b.score) return b.score - a.score;
		return ba.localeCompare(aa) || idOf(a).localeCompare(idOf(b));
	};
	const holdsSessions = (id: string, seen: Set<string>): boolean => occupied.has(id)
		|| folders.some((f) => f.parentId === id && !seen.has(f.id) && holdsSessions(f.id, new Set([...seen, f.id])));
	const build = (parentId: string | null, seen: Set<string>): SessionTreeNode<T>[] => {
		const children: SessionTreeNode<T>[] = [...(sessionsByFolder.get(parentId) ?? [])];
		for (const folder of folders) {
			if (folder.parentId !== parentId || seen.has(folder.id)) continue;
			const within = new Set([...seen, folder.id]);
			const inner = build(folder.id, within);
			let activity: string | null = null;
			let score = 0;
			for (const child of inner) {
				const childActivity = activityOf(child);
				if (childActivity !== null && (activity === null || childActivity > activity)) activity = childActivity;
				if (childActivity !== null) score = Math.max(score, child.score);
			}
			if (activity === null && (query
				|| (holdsSessions(folder.id, within) && !inner.some((child) => child.type === "folder")))) continue;
			children.push({ type: "folder", folder, children: inner, activity, score });
		}
		return children.sort(compare);
	};
	return build(null, new Set());
}

export type SessionTreeRow<T extends SidebarSession> =
	| { type: "session"; session: T; depth: number }
	| { type: "folder"; folder: SourceFolder; depth: number; open: boolean; hasChildren: boolean };

/** Flatten for rendering/keyboard walking: closed folders hide their contents. */
export function flattenSessionTree<T extends SidebarSession>(
	nodes: readonly SessionTreeNode<T>[],
	isOpen: (folderId: string) => boolean,
	depth = 0,
	rows: SessionTreeRow<T>[] = [],
): SessionTreeRow<T>[] {
	for (const node of nodes) {
		if (node.type === "session") { rows.push({ type: "session", session: node.session, depth }); continue; }
		const open = isOpen(node.folder.id);
		rows.push({ type: "folder", folder: node.folder, depth, open, hasChildren: node.children.length > 0 });
		if (open) flattenSessionTree(node.children, isOpen, depth + 1, rows);
	}
	return rows;
}

// ─── Graph folder filter (view only) ────────────────────────────────────────

/** A folder plus every descendant folder (cycle-safe). */
export function folderAndDescendants(organization: SourceOrganization, id: string): string[] {
	const out = [id];
	const seen = new Set(out);
	for (let i = 0; i < out.length; i++) {
		for (const folder of organization.folders) {
			if (folder.parentId === out[i] && !seen.has(folder.id)) { seen.add(folder.id); out.push(folder.id); }
		}
	}
	return out;
}

/** Folders the graph filter lists: those whose subtree holds at least one
 * source (session or notes file) with propositions in the graph. */
export function graphFolderIds(organization: SourceOrganization, graphSourceIds: ReadonlySet<string>): Set<string> {
	const listed = new Set<string>();
	const folderIds = new Set(organization.folders.map((f) => f.id));
	for (const sourceId of graphSourceIds) {
		let folder = placementOf(organization, sourceId)?.folderId ?? null;
		const seen = new Set<string>();
		while (folder !== null && folderIds.has(folder) && !seen.has(folder)) {
			seen.add(folder);
			listed.add(folder);
			folder = organization.folders.find((f) => f.id === folder)?.parentId ?? null;
		}
	}
	return listed;
}

/** Ticking a folder includes its listed subfolders; unticking removes them. */
export function toggleGraphFolder(organization: SourceOrganization, selected: ReadonlySet<string>, id: string,
	checked: boolean, listed: ReadonlySet<string>): Set<string> {
	const next = new Set(selected);
	for (const folder of folderAndDescendants(organization, id)) {
		if (!listed.has(folder)) continue;
		if (checked) next.add(folder); else next.delete(folder);
	}
	return next;
}

/** Checkbox state: indeterminate when the folder's listed subtree is mixed. */
export function graphFolderCheck(organization: SourceOrganization, selected: ReadonlySet<string>, id: string,
	listed: ReadonlySet<string>): { checked: boolean; indeterminate: boolean } {
	const subtree = folderAndDescendants(organization, id).filter((f) => listed.has(f));
	const count = subtree.filter((f) => selected.has(f)).length;
	const checked = selected.has(id);
	return { checked, indeterminate: count > 0 && count < subtree.length };
}

export interface FolderDeletionScope {
	parentId: string | null;
	folderIds: string[];
	chatIds: string[];
	noteIds: string[];
}

/** The sidebar confirmation and server guard use the same unfiltered inventory.
 * Sort IDs so ordinary directory reordering (e.g. session activity) is irrelevant. */
export function folderDeletionScope(directory: SourceDirectory, folderId: string): FolderDeletionScope | null {
	const { organization, sources } = directory;
	const folder = organization.folders.find((f) => f.id === folderId);
	if (!folder) return null;
	const folderIds = folderAndDescendants(organization, folderId).sort();
	const inside = new Set(folderIds);
	const chatIds: string[] = [], noteIds: string[] = [];
	for (const source of sources) {
		const placed = placementOf(organization, source.id)?.folderId;
		if (placed == null || !inside.has(placed)) continue;
		if (source.kind === "chat") chatIds.push(source.id);
		if (source.kind === "notes") noteIds.push(source.id);
	}
	return { parentId: folder.parentId, folderIds, chatIds: chatIds.sort(), noteIds: noteIds.sort() };
}

/**
 * The graph's folder-visible node ids, or null when no listed folder is
 * selected (whole graph). A proposition is visible when ANY of its surviving
 * sources is placed directly in a selected folder; derived implication nodes
 * only when their conclusion and every premise are visible.
 */
export function graphFolderVisibleIds(input: {
	organization: SourceOrganization;
	selected: ReadonlySet<string>;
	listed: ReadonlySet<string>;
	propositionIds: readonly string[];
	nodeSources: Readonly<Record<string, readonly string[]>>;
	impLinks: ReadonlyArray<{ id: string; premises: readonly string[]; conclusion: string }>;
}): Set<string> | null {
	const active = new Set([...input.selected].filter((id) => input.listed.has(id)));
	if (active.size === 0) return null;
	const visible = new Set<string>();
	for (const id of input.propositionIds) {
		const sources = input.nodeSources[id] ?? [];
		if (sources.some((source) => {
			const folder = placementOf(input.organization, source)?.folderId ?? null;
			return folder !== null && active.has(folder);
		})) visible.add(id);
	}
	for (const link of input.impLinks) {
		if (visible.has(link.conclusion) && link.premises.every((p) => visible.has(p))) visible.add(link.id);
	}
	return visible;
}

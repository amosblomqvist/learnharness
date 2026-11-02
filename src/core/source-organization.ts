/** Source organization is presentation metadata, never graph/extraction identity.
 * A source has one parent; folders have stable IDs independent of names/paths. */
export interface SourceFolder {
	id: string;
	name: string;
	parentId: string | null;
	createdAt: string;
	/** Original picker-relative directory, retained through renames/moves. */
	importPath?: string;
}
export interface SourcePlacement {
	folderId: string | null;
	/** Imported-file display override only; chat titles live in ChatStore. */
	name?: string;
}
export interface SourceOrganization {
	version: 1;
	folders: SourceFolder[];
	placements: Record<string, SourcePlacement>;
}
export interface SourceEntry {
	id: string;
	kind: "chat" | "notes" | "missing";
	label: string | null;
	createdAt: string | null;
	filePath?: string;
}
export interface SourceDirectory {
	organization: SourceOrganization;
	sources: SourceEntry[];
}
export type OrganizationAction =
	| { action: "create-folder"; name: string; parentId: string | null }
	| { action: "rename-folder"; id: string; name: string }
	| { action: "rename-source"; id: string; name: string }
	| { action: "move"; kind: "source" | "folder"; id: string; parentId: string | null }
	| { action: "delete-folder"; id: string };

export const emptySourceOrganization = (): SourceOrganization => ({ version: 1, folders: [], placements: {} });
export const placementOf = (state: SourceOrganization, id: string): SourcePlacement | undefined =>
	Object.hasOwn(state.placements, id) ? state.placements[id] : undefined;

export function folderIsEmpty(state: SourceOrganization, id: string, sourceIds: ReadonlySet<string>): boolean {
	return !state.folders.some((f) => f.parentId === id)
		&& ![...sourceIds].some((sourceId) => placementOf(state, sourceId)?.folderId === id);
}

/** Also used to validate drops server-side, including stale/crafted clients. */
export function canMoveFolder(state: SourceOrganization, id: string, parentId: string | null): boolean {
	const seen = new Set<string>([id]);
	for (let next = parentId; next !== null;) {
		if (seen.has(next)) return false;
		seen.add(next);
		const folder = state.folders.find((f) => f.id === next);
		if (!folder) return false;
		next = folder.parentId;
	}
	return true;
}

/** Reject unsupported/corrupt data rather than overwrite organization on a write. */
export function parseSourceOrganization(raw: unknown): SourceOrganization {
	const fail = (): never => { throw new Error("Could not read source organization. Its data is invalid or newer than this app."); };
	if (!raw || typeof raw !== "object") return fail();
	const r = raw as Partial<SourceOrganization>;
	if (r.version !== 1 || !Array.isArray(r.folders) || !r.placements || typeof r.placements !== "object" || Array.isArray(r.placements)) return fail();
	const ids = new Set<string>();
	for (const f of r.folders) {
		if (!f || typeof f.id !== "string" || !f.id || ids.has(f.id) || typeof f.name !== "string" || !f.name.trim()
			|| (f.parentId !== null && typeof f.parentId !== "string") || typeof f.createdAt !== "string"
			|| (f.importPath !== undefined && typeof f.importPath !== "string")) return fail();
		ids.add(f.id);
	}
	const state = r as SourceOrganization;
	for (const f of state.folders) if (!canMoveFolder(state, f.id, f.parentId)) return fail();
	for (const p of Object.values(state.placements)) {
		if (!p || typeof p !== "object" || (p.folderId !== null && !ids.has(p.folderId))
			|| (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim()))) return fail();
	}
	return state;
}

export function parseOrganizationAction(raw: unknown): OrganizationAction {
	if (!raw || typeof raw !== "object") throw new Error("Invalid source organization action.");
	const r = raw as Record<string, unknown>;
	const id = () => { if (typeof r.id !== "string" || !r.id) throw new Error("A source or folder ID is required."); return r.id; };
	const name = () => { if (typeof r.name !== "string" || !r.name.trim()) throw new Error("Name must be a non-empty string."); return r.name.trim(); };
	const parent = () => { if (r.parentId !== null && typeof r.parentId !== "string") throw new Error("Invalid parent folder."); return r.parentId; };
	switch (r.action) {
		case "create-folder": return { action: r.action, name: name(), parentId: parent() };
		case "rename-folder": case "rename-source": return { action: r.action, id: id(), name: name() };
		case "delete-folder": return { action: r.action, id: id() };
		case "move":
			if (r.kind !== "source" && r.kind !== "folder") throw new Error("Invalid move kind.");
			return { action: r.action, id: id(), kind: r.kind, parentId: parent() };
		default: throw new Error("Unknown source organization action.");
	}
}

/** Operation-based updates preserve unrelated edits; no whole-state client writes. */
export function applyOrganizationAction(state: SourceOrganization, action: Exclude<OrganizationAction, { action: "rename-source" }>,
	sourceIds: ReadonlySet<string>, newFolder: { id: string; createdAt: string }): SourceOrganization {
	const next = structuredClone(state);
	if ("parentId" in action && action.parentId !== null && !next.folders.some((f) => f.id === action.parentId)) throw new Error("Parent folder no longer exists.");
	if (action.action === "create-folder") {
		next.folders.push({ ...newFolder, name: action.name, parentId: action.parentId });
		return next;
	}
	if (action.action === "move" && action.kind === "source") {
		if (!sourceIds.has(action.id)) throw new Error("Source no longer exists.");
		next.placements = { ...next.placements, [action.id]: { ...placementOf(next, action.id), folderId: action.parentId } };
		return next;
	}
	const folder = next.folders.find((f) => f.id === action.id);
	if (!folder) throw new Error("Folder no longer exists.");
	if (action.action === "rename-folder") folder.name = action.name;
	else if (action.action === "move") {
		if (!canMoveFolder(next, action.id, action.parentId)) throw new Error("A folder cannot be moved into itself or its descendants.");
		folder.parentId = action.parentId;
	} else {
		if (!folderIsEmpty(next, action.id, sourceIds)) throw new Error("Only empty folders can be removed. Move their entries out first.");
		next.folders = next.folders.filter((f) => f.id !== action.id);
		for (const [id, p] of Object.entries(next.placements)) if (p.folderId === action.id) next.placements[id] = { ...p, folderId: null };
	}
	return next;
}

/** Reconstruct only directories needed by eligible files. Associations follow
 * stable folder IDs, not current names/parents; existing placements always win. */
export function placeImportedSource(state: SourceOrganization, sourceId: string, filePath: string,
	makeFolder: () => { id: string; createdAt: string }): SourceOrganization {
	if (placementOf(state, sourceId)) return state;
	const next = structuredClone(state);
	const directories = filePath.split("/").slice(0, -1);
	let parentId: string | null = null;
	let start = 0;
	// Reuse the deepest association first. Its original ancestors might have
	// been moved/deleted; do not recreate now-unused empty ancestors.
	for (let i = directories.length - 1; i >= 0; i--) {
		const existing = next.folders.find((f) => f.importPath === directories.slice(0, i + 1).join("/"));
		if (existing) { parentId = existing.id; start = i + 1; break; }
	}
	for (let i = start; i < directories.length; i++) {
		const folder: SourceFolder = { ...makeFolder(), name: directories[i]!, parentId, importPath: directories.slice(0, i + 1).join("/") };
		next.folders.push(folder);
		parentId = folder.id;
	}
	next.placements = { ...next.placements, [sourceId]: { folderId: parentId } };
	return next;
}

import { createHash, randomUUID } from "node:crypto";
import { stores } from "./stores.ts";
import type { ChatStore, GraphStore, SourceOrganizationStore } from "../core/ports.ts";
import { getGraph } from "../core/graph.ts";
import { sourceFileLabel } from "../core/source-label.ts";
import {
	applyOrganizationAction, parseOrganizationAction, placeImportedSource, placementOf,
	type SourceDirectory, type SourceEntry,
} from "../core/source-organization.ts";

export class SourceOrganizationInputError extends Error {}

export function createSourceDirectory(deps: { chatStore: ChatStore; graphStore: GraphStore; sourceOrganizationStore: SourceOrganizationStore }) {
	const freshFolder = () => ({ id: `folder_${randomUUID()}`, createdAt: new Date().toISOString() });
	function read(): SourceDirectory {
		const organization = deps.sourceOrganizationStore.read();
		const entries = new Map<string, SourceEntry>();
		for (const c of deps.chatStore.listChats()) entries.set(c.id, { id: c.id, kind: "chat", label: c.title, createdAt: c.createdAt });
		for (const s of deps.graphStore.readSources()) entries.set(s.id, {
			id: s.id, kind: "notes", label: placementOf(organization, s.id)?.name ?? sourceFileLabel(s.filePath),
			filePath: s.filePath, createdAt: s.importedAt,
		});
		// Preserve graph groups whose naming record is gone; do not resurrect a chat.
		for (const node of getGraph(deps.graphStore).nodes) for (const p of node.provenance) {
			if (!entries.has(p.chatId)) entries.set(p.chatId, { id: p.chatId, kind: "missing", label: null, createdAt: null });
		}
		return { organization, sources: [...entries.values()] };
	}
	function change(raw: unknown): SourceDirectory & { createdFolderId?: string } {
		let action;
		let createdFolderId: string | undefined;
		try { action = parseOrganizationAction(raw); }
		catch (error) { throw new SourceOrganizationInputError((error as Error).message); }
		const directory = read();
		if (action.action === "rename-source") {
			const entry = directory.sources.find((s) => s.id === action.id);
			if (!entry || entry.kind === "missing") throw new SourceOrganizationInputError("Source no longer exists.");
			if (entry.kind === "chat") deps.chatStore.renameChat(entry.id, action.name);
			else {
				const state = directory.organization;
				state.placements = { ...state.placements, [entry.id]: { folderId: null, ...placementOf(state, entry.id), name: action.name } };
				deps.sourceOrganizationStore.write(state);
			}
		} else {
			let next;
			const fresh = freshFolder();
			try { next = applyOrganizationAction(directory.organization, action, new Set(directory.sources.map((s) => s.id)), fresh); }
			catch (error) { throw new SourceOrganizationInputError((error as Error).message); }
			deps.sourceOrganizationStore.write(next);
			if (action.action === "create-folder") createdFolderId = fresh.id;
		}
		return { ...read(), ...(createdFolderId ? { createdFolderId } : {}) };
	}
	/** Before starting the file's existing extraction pipeline. The source key
	 * is the pipeline's unchanged path hash; no source text is stored here. */
	function registerImport(filePath: string): void {
		const id = `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
		const state = deps.sourceOrganizationStore.read();
		// Legacy imports with no organization record already live at root.
		// Explicitly preserve that placement on re-import too.
		if (!placementOf(state, id) && deps.graphStore.readSources().some((s) => s.id === id)) {
			state.placements = { ...state.placements, [id]: { folderId: null } };
			deps.sourceOrganizationStore.write(state);
			return;
		}
		const next = placeImportedSource(state, id, filePath, freshFolder);
		if (next !== state) deps.sourceOrganizationStore.write(next);
	}
	return { read, change, registerImport };
}

export const sourceDirectory = createSourceDirectory(stores);

/** Bound actual JSON bytes as well as declared size; never buffer an unbounded
 * operation body. A cancelled tee must not delay the refusal. */
export async function readOrganizationAction(request: Request): Promise<unknown> {
	const limit = 64 * 1024;
	if (Number(request.headers.get("content-length")) > limit) {
		void request.body?.cancel().catch(() => undefined);
		throw new SourceOrganizationInputError("Source organization request is too large.");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SourceOrganizationInputError("Missing source organization action.");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new SourceOrganizationInputError("Source organization request is too large.");
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		if (error instanceof SourceOrganizationInputError) throw error;
		throw new SourceOrganizationInputError("Could not read source organization action.");
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

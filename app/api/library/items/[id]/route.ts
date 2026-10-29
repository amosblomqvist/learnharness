import { deleteLibraryItem, libraryDeletionImpact, stores } from "@/src/server";
import { isLibraryTag, type LibraryTag } from "@/src/core";

/**
 * PATCH /api/library/items/[id] {name?, parentId?, tag?} — rename, move
 * (parentId null = top level), retag (tag null clears the item's own tag;
 * it then inherits again). The store enforces tree integrity.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!stores.libraryStore.getItem(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return Response.json({ error: "Expected a JSON body" }, { status: 400 });
	const patch: { name?: string; parentId?: string | null; tag?: LibraryTag | null } = {};
	if ("name" in body) {
		if (typeof body.name !== "string") return Response.json({ error: "name must be a string" }, { status: 400 });
		patch.name = body.name;
	}
	if ("parentId" in body) {
		if (body.parentId !== null && typeof body.parentId !== "string") {
			return Response.json({ error: "parentId must be a string or null" }, { status: 400 });
		}
		patch.parentId = body.parentId;
	}
	if ("tag" in body) {
		if (body.tag !== null && !isLibraryTag(body.tag)) return Response.json({ error: "Unknown tag" }, { status: 400 });
		patch.tag = body.tag;
	}
	try {
		return Response.json({ item: stores.libraryStore.updateItem(id, patch) });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
	}
}

/**
 * DELETE /api/library/items/[id] — removes the item and everything beneath
 * it, detaching it from the chats that attached it (owner ruling: warn,
 * then detach; past messages untouched). ?dryRun=1 only reports the
 * impact — the confirm dialog's list of chats using it.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
	const impact = dryRun ? libraryDeletionImpact(id) : deleteLibraryItem(id);
	if (!impact) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ impact, deleted: !dryRun });
}

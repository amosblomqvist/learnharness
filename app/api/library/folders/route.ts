import { stores } from "@/src/server";
import { validateLibraryName } from "@/src/core";

/** POST /api/library/folders {parentId: string|null, name} → {item}. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { parentId?: unknown; name?: unknown } | null;
	const parentId = body?.parentId ?? null;
	if (parentId !== null && typeof parentId !== "string") {
		return Response.json({ error: "parentId must be a string or null" }, { status: 400 });
	}
	const name = validateLibraryName(body?.name);
	if (!name.ok) return Response.json({ error: name.error }, { status: 400 });
	try {
		return Response.json({ item: stores.libraryStore.createFolder(parentId, name.name) });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
	}
}

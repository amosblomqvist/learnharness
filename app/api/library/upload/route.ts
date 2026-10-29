import { stores, uploadLibraryFile, type UploadResult } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/library/upload — multipart: field "parentId" (a folder id, or
 * empty for the top level) + one or more "files". Each file is validated
 * and copied independently (one bad file never sinks the others); import
 * processing runs in the background and announces library-changed.
 * The client sends ONE file per request: the proxy buffers bodies up to
 * next.config.ts proxyClientMaxBodySize, sized for one 100MB file.
 */
export async function POST(req: Request) {
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return Response.json({ error: "Expected multipart form data" }, { status: 400 });
	}
	const rawParent = form.get("parentId");
	const parentId = typeof rawParent === "string" && rawParent !== "" ? rawParent : null;
	if (parentId !== null && stores.libraryStore.getItem(parentId)?.kind !== "folder") {
		return Response.json({ error: "Folder not found" }, { status: 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) return Response.json({ error: "No files" }, { status: 400 });
	const results: UploadResult[] = [];
	for (const file of files) {
		results.push(uploadLibraryFile(parentId, file.name, new Uint8Array(await file.arrayBuffer())));
	}
	return Response.json({ results }, { status: results.some((r) => r.ok) ? 200 : 400 });
}

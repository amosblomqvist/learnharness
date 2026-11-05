/**
 * POST /api/uploads — one browser attachment per request (LAN web access, S4).
 * Raw body; the file name rides in the URI-encoded `x-file-name` header.
 * Content-Length is required (411) and capped at MAX_IMPORT_BODY_BYTES (413),
 * the size Next's proxy buffers; a body that differs from it is 400 and leaves
 * no file. 200 → `{ path }`, the absolute host path.
 */
import { saveUpload } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	const result = await saveUpload(req.headers, req.body);
	if (result.status === 200) return Response.json({ path: result.path });
	return Response.json({ error: result.error }, { status: result.status });
}

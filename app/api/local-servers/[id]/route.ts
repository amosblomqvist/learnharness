/**
 * DELETE /api/local-servers/:id — forget one local model server (local-models
 * wave, 2026-10-24): its settings entry, its stored key, and its provider go
 * together. 404 for an unknown id.
 */
import { removeLocalServer } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	const result = removeLocalServer(id);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ ok: true });
}

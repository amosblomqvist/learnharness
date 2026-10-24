/**
 * One curated dictation model (issue #15, PR #50).
 *
 *   POST   → 202 {started: true}: download it from Hugging Face into the
 *            data dir (progress via GET /api/stt/methods). Idempotent.
 *   DELETE → 200 {deleted: true}: cancel the download or delete the
 *            files; a removed pick falls to the default choice.
 *
 * Unknown ids are 404 — only the curated catalog downloads. Access
 * control is the app-wide /api capability check (proxy.ts).
 */
import { removeModel, startModelDownload } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	if (!startModelDownload(id)) return Response.json({ error: "Unknown model." }, { status: 404 });
	return Response.json({ started: true }, { status: 202 });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	if (!removeModel(id)) return Response.json({ error: "Unknown model." }, { status: 404 });
	return Response.json({ deleted: true });
}

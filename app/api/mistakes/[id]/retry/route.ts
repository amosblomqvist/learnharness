import { retryMistake } from "@/src/server";

export const dynamic = "force-dynamic";

/** Re-run one mistake's analysis (after a failure, or to redo it). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!retryMistake(decodeURIComponent(id))) return Response.json({ error: "No such mistake." }, { status: 404 });
	return Response.json({ ok: true });
}

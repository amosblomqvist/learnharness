import { getChat } from "@/src/server";

/** Session-owned snapshots only: never opens a source path or accepts uploaded bytes. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; snapshotId: string }> }) {
	const { id, snapshotId } = await params;
	if (!/^[a-f0-9]{64}$/.test(snapshotId)) return Response.json({ error: "Not found" }, { status: 404 });
	const image = getChat(id)?.imageSnapshots?.[snapshotId];
	if (!image) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(image, { headers: { "Cache-Control": "private, no-store" } });
}

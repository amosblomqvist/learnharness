import { deleteMistake } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!deleteMistake(decodeURIComponent(id))) return Response.json({ error: "No such mistake." }, { status: 404 });
	return Response.json({ ok: true });
}

import { noteIndex } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	return Response.json(noteIndex((await params).id));
}

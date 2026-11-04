// POST /api/chats/[id]/side-question/tell — tell the tutor about a side
// thread that was closed private (#16): its note lands at the record's end.
import { handleSideTell } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return handleSideTell(id, await request.json().catch(() => null));
}

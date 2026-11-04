// POST /api/chats/[id]/side-question — one side question (#16, "/btw"),
// answered by the side agent as an SSE stream. Never starts a turn and
// never writes a message; the thread is committed by …/side-question/close.
import { handleSideQuestion } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return handleSideQuestion(id, await request.json().catch(() => null));
}

// POST /api/chats/[id]/side-question/close — commit a closed side thread
// (#16): one side-question marker, now or once the lesson can take it.
// The client also sends this as a keepalive request when the page hides,
// so the body is read as text and parsed here.
import { handleSideClose } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const text = await request.text().catch(() => "");
	let body: unknown = null;
	try { body = JSON.parse(text); } catch { /* a 400 below */ }
	return handleSideClose(id, body);
}

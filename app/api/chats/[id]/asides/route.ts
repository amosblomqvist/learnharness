/**
 * POST /api/chats/[id]/asides — the aside thread's front door (issue #16).
 * Body: { text } — the learner's quick clarification question. The service
 * (src/server/asides.ts) owns every gate and the synchronous one-shot
 * answer; this wrapper only parses and dispatches (the chat route's
 * one-line-wrapper law). Responses: 200 { ok, thread } on success; 400
 * empty text; 404 unknown chat; 409 while a main turn runs or another
 * aside is being answered; 503 model/key envelopes; 502/504/500 answer
 * failures. The aside NEVER writes ChatRecord.messages and NEVER holds
 * turn liveness — the lesson is untouched.
 */
import { askAside } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	let text: unknown;
	try {
		const body = (await req.json()) as { text?: unknown };
		text = body?.text;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (typeof text !== "string") {
		return Response.json({ error: "text must be a string" }, { status: 400 });
	}
	return askAside(id, text);
}

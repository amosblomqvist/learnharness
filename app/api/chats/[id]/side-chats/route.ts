/**
 * Side questions (inline clarification threads, owner design 2026-11-02).
 *
 * GET  → { threads, answering }: the session's side threads plus, for each
 *        thread whose answer is still running, the text streamed so far.
 * POST → ask: { threadId, text, quotes? } (follow-up), { anchor, text,
 *        quotes? } (first question at a teacher-prose block), or
 *        { threadId, retry: true } (re-answer a failed last answer).
 *        Streams NDJSON (src/server/side-chat.ts documents the wire);
 *        refusals are ordinary JSON errors (400/404/409/503).
 *
 * Thin wrapper over the server barrel (the import law); tests drive
 * createSideChatService directly.
 */
import { parseSideAskInput, SideChatInputError } from "@/src/core";
import { sideChats } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const listed = sideChats.list(id);
	if (!listed) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json(listed);
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	let input;
	try {
		input = parseSideAskInput(await request.json().catch(() => null));
	} catch (err) {
		if (err instanceof SideChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	return sideChats.ask(id, input);
}

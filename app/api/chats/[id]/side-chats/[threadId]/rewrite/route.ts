/**
 * POST → the smallest rewrite of a reviewed note's highlight: { replacement }.
 * The client applies it; the server edits nothing.
 */
import { noteRewriter } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; threadId: string }> }): Promise<Response> {
	const { id, threadId } = await ctx.params;
	return noteRewriter.rewrite(id, threadId, req.signal);
}

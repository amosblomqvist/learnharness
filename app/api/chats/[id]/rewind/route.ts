// POST /api/chats/[id]/rewind — edit the last sent message (issue #321).
// The learner's last message and everything after it is removed as if it
// never happened: the running turn is stopped first, and the graph, plan
// tree, background jobs and parked steers the tail produced are undone with
// it (src/server/rewind.ts). The response carries the removed message's
// text; the client puts it back in the composer, and resending it is the
// ordinary send.
//
// Only the chat's LAST user message is editable: 409 not_last_user_message
// names the one that is. 409 compaction_running and 503 (a turn or the
// extraction still winding down) are retryable and change nothing.
import { getChat, rewindChat } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "unknown chat" }, { status: 404 });
	let messageId: unknown;
	try {
		messageId = ((await request.json()) as { messageId?: unknown } | null)?.messageId;
	} catch {
		return Response.json({ error: "body must be valid JSON" }, { status: 400 });
	}
	if (typeof messageId !== "string" || messageId.length === 0) {
		return Response.json({ error: "messageId must be a non-empty string" }, { status: 400 });
	}
	const outcome = await rewindChat(id, messageId);
	if (!outcome.ok) {
		const { ok: _ok, status, ...body } = outcome;
		return Response.json(body, { status });
	}
	const { ok: _ok, ...body } = outcome;
	return Response.json({ ok: true, ...body });
}

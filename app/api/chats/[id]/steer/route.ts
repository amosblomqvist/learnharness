// POST /api/chats/[id]/steer — the composer's mid-turn steering rail
// (owner arc 2026-10-03). The learner's message for a RUNNING turn rides
// pi's steering queue: drained at the next response boundary INSIDE the
// same run (agent.steer + steeringMode "all"), forwarded verbatim on the
// live stream (the client upserts the card by the client-minted id), and
// persisted by the turn's own settlement.
//
// This is steering, NOT follow-ups: the route never starts a turn and
// never extends an ended one. No live turn → 409 and the client falls
// back to a plain text send (the settle race). Stranding safety: the
// registry copy survives a question termination or abort and rides the
// chat's next run.
import { ChatInputError, newUserSteer, parseUserSteerEditInput, parseUserSteerInput } from "@/src/core";
import { editLiveSteer, getChat, steerLiveChat } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "unknown chat" }, { status: 404 });
	let input;
	try {
		const body = (await request.json()) as { input?: unknown };
		input = parseUserSteerInput(body?.input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const message = newUserSteer(input.text, input.id);
	if (!steerLiveChat(id, message)) {
		return Response.json({ error: "no live turn to steer" }, { status: 409 });
	}
	return Response.json({ ok: true });
}

// PUT — edit (or, with blank text, cancel) a steer that is still queued
// (issue #321). Same rail, same rule: only a LIVE turn has a queue, and only
// a steer pi has not drained yet is editable — anything else is a 409 and
// the client keeps the text it already shows.
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "unknown chat" }, { status: 404 });
	let input;
	try {
		const body = (await request.json()) as { input?: unknown };
		input = parseUserSteerEditInput(body?.input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		if (err instanceof SyntaxError) return Response.json({ error: "body must be valid JSON" }, { status: 400 });
		throw err;
	}
	if (!editLiveSteer(id, input.id, input.text)) {
		return Response.json({ error: "no queued steer to edit" }, { status: 409 });
	}
	return Response.json({ ok: true });
}

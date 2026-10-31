import { withUser } from "@/src/server/auth/context.ts";
/**
 * THE SILENT DISMISSAL ROUTE (owner design 2026-10-03, "A2"): ESC-abort
 * from a pending question writes the dismissed toolResult to the record
 * and wakes NOTHING — no beginTurn, no agent, no tokens. The session
 * enters the derived dismissal pause (endsInDismissal): job deliveries
 * hold in the wake pipeline's steer queue, the continuation fold demands
 * nothing, and the user's next plain message is the wake that carries
 * the dismissal (plus any held deliveries) into the agent's context.
 *
 * Parallel question calls: each dismissal completes exactly its own call
 * (results bind by toolCallId, not position), so the dock advances
 * call-by-call and the composer returns only when nothing dangles.
 *
 * Guards mirror the turn route's honesty: 404 unknown chat, 400 for an
 * input that targets no dangling question call (or isn't a real
 * dismissal). A RUNNING turn no longer refuses (owner, 2026-10-04 — the
 * GLM practice-loop incident): the dismissal is PARKED server-side and
 * the turn's settle path applies it against the persisted record, so
 * ESC-discard now doubles as the turn abort's bookkeeper (the client
 * fires both).
 */
import { ChatInputError, dismissAppends, emit, parseDismissInput } from "@/src/core";
import { getChat, isTurnRunning, parkDismissal, stores } from "@/src/server";

export const POST = withUser(async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	let input;
	try {
		// The POST-family convention: the body is { input } (chatId lives in
		// the URL here).
		const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
		input = parseDismissInput(body?.input ?? null);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	// A running turn owns the chat's record (its messages persist at
	// settle) — the dismissal cannot validate against stale truth, so it
	// is PARKED (owner, 2026-10-04): onFinish applies it to the settled
	// record if the dismissed question/problem really is pending there.
	// The dismissing client has also aborted the turn — this 202 is the
	// "noted, will land" contract.
	if (isTurnRunning(id)) {
		parkDismissal(id, input);
		return Response.json({ ok: true, parked: true }, { status: 202 });
	}

	let appends;
	try {
		appends = dismissAppends(chat, input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	// Write-ahead, turn-less: the record is the only state that moves.
	const merged = [...chat.messages, ...appends];
	stores.chatStore.saveMessages(id, merged);
	emit("record-changed", { chatId: id });
	return Response.json({ ok: true });
});

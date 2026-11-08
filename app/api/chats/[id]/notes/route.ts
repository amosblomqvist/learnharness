import { NotesInputError, parseNotesInput } from "@/src/core";
import { readChatNotes, saveChatNotes } from "@/src/server";

/** The saved notes — re-read on mount, since Back/Forward can replay a stale page payload. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const text = readChatNotes((await params).id);
	if (text === null) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ text });
}

/** Save the session's Markdown notes — a per-field write on the record. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	let text: string;
	try {
		text = parseNotesInput(body);
	} catch (e) {
		if (e instanceof NotesInputError) return Response.json({ error: e.message }, { status: 400 });
		throw e;
	}
	if (!saveChatNotes(id, text)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ ok: true });
}

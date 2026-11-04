import { chatAttachmentsSnapshot, getChat, requestAttachmentSummaries, setChatAttachments } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/chats/[id]/attachments — the chat's attached library items and
 *  every file they put in scope, with processing + summary state. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(chatAttachmentsSnapshot(id));
}

/**
 * PUT /api/chats/[id]/attachments {attachments: string[]} — replace-whole
 * (the Materials panel sends the complete desired list; [] detaches all).
 * Kicks off summaries for in-scope files that lack one; the next turn
 * waits for them (owner ruling 2026-10-29).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { attachments?: unknown } | null;
	const ids = body?.attachments;
	if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string")) {
		return Response.json({ error: "attachments must be an array of library item ids" }, { status: 400 });
	}
	const result = setChatAttachments(id, ids);
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	requestAttachmentSummaries(id);
	return Response.json(chatAttachmentsSnapshot(id));
}

import { getChat, stores } from "@/src/server";

/**
 * PATCH /api/chats/[id]/attachments/[attachmentId] — soft detach / restore
 * one session attachment (2026-10-29). Body {detached: boolean}. Detach
 * sets the record's `detachedAt` (the record and its blob stay, so Undo
 * needs no re-upload); restore clears it. Takes effect on the next turn:
 * agents are built per turn from the record.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
	const { id, attachmentId } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	if (typeof body?.detached !== "boolean") return Response.json({ error: "detached must be true or false" }, { status: 400 });

	const attachment = stores.chatStore.setAttachmentDetached(id, attachmentId, body.detached);
	if (!attachment) return Response.json({ error: "Attachment not found" }, { status: 404 });
	return Response.json({ attachment });
}

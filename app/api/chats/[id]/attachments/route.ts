import { addChatAttachment, getChat } from "@/src/server";
import { ATTACHMENT_MAX_BYTES } from "@/src/core";

/**
 * POST /api/chats/[id]/attachments — session context attachments
 * (2026-10-29). Multipart field "file": exactly one file per request,
 * because proxy.ts buffers bodies up to next.config's
 * proxyClientMaxBodySize, sized for one ATTACHMENT_MAX_BYTES file. The
 * file is validated, stored once by content (shared blob store),
 * inspected, and recorded on the chat: 200 {attachment} or 422 {error}.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > ATTACHMENT_MAX_BYTES + 1024 * 1024) {
		return Response.json({ error: "Upload is too large — attach one file of at most 50 MB per request." }, { status: 413 });
	}
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return Response.json({ error: "Invalid upload body" }, { status: 400 });
	}
	const upload = form.get("file");
	if (!(upload instanceof File)) return Response.json({ error: 'Attach one file in the "file" field.' }, { status: 400 });
	const result = await addChatAttachment(id, { name: upload.name, bytes: new Uint8Array(await upload.arrayBuffer()) });
	return result.ok ? Response.json({ attachment: result.attachment }) : Response.json({ error: result.error }, { status: 422 });
}

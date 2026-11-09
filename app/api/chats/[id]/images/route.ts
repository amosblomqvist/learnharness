import { attachChatImage, getChat } from "@/src/server";

/**
 * The composer's image upload (issue #96): POST one picture for THIS
 * session. Bytes run through the SAME shared pipeline as learner images
 * (show_image / visual): 25 MiB / 16 MP / 8192px input bounds, off-thread
 * orientation + metadata cleanup, stored PNG/JPEG bounded to 1600px and
 * under 1 MiB of base64. The processed bytes land in
 * ChatRecord.imageSnapshots under their SHA-256 identity (session-scoped
 * dedupe — the same picture twice stores once); the response carries only
 * the REF the next send attaches to its text input. The composer never
 * ships image bytes through POST /api/chat.
 *
 * Sibling of the snapshot GET route one level down; that GET stays the
 * read side (cards, thumbnails) unchanged.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	let file: File | null = null;
	try {
		const form = await req.formData();
		const value = form.get("file");
		if (value instanceof File) file = value;
	} catch {
		/* fall through to the 400 below */
	}
	if (!file) return Response.json({ error: "Expected a multipart form with a file field." }, { status: 400 });

	// The provenance name: what the chip, the alt text, and the honest
	// non-vision note show. Bounded to the contract's 200-character cap.
	const name = (file.name || "image").slice(0, 200);
	try {
		const stored = await attachChatImage(id, new Uint8Array(await file.arrayBuffer()));
		return Response.json({ snapshotId: stored.snapshotId, name, mimeType: stored.mimeType, width: stored.width, height: stored.height });
	} catch (error) {
		const message = error instanceof Error ? error.message : "The image could not be processed.";
		const tooLarge = /25 MiB/.test(message);
		return Response.json({ error: message }, { status: tooLarge ? 413 : 400 });
	}
}

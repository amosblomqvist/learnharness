import * as fs from "node:fs/promises";
import { MEDIA_ID_RE } from "@/src/core";
import { stores, transcribeMediaBytes } from "@/src/server";

/**
 * Best-effort batch transcription for a session-stored audio/video asset.
 * Uses configured BYOK keys (Deepgram first, then OpenAI Whisper). Returns
 * `{ available: false, transcript: null }` with HTTP 200 when no key is set
 * so learner uploads never fail solely because STT isn't configured.
 */
export async function POST(req: Request) {
	let body: { chatId?: unknown; mediaId?: unknown };
	try {
		body = (await req.json()) as { chatId?: unknown; mediaId?: unknown };
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (typeof body.chatId !== "string" || !body.chatId || typeof body.mediaId !== "string" || !MEDIA_ID_RE.test(body.mediaId)) {
		return Response.json({ error: "chatId and valid mediaId are required" }, { status: 400 });
	}

	const meta = stores.mediaStore.getMediaMeta(body.chatId, body.mediaId);
	const filePath = meta ? stores.mediaStore.getMediaFilePath(body.chatId, body.mediaId) : null;
	if (!meta || !filePath) {
		return Response.json({ error: "Media asset not found" }, { status: 404 });
	}
	if (meta.kind !== "audio" && meta.kind !== "video") {
		return Response.json({ available: false, transcript: null }, { status: 200 });
	}

	try {
		const bytes = new Uint8Array(await fs.readFile(filePath));
		const result = await transcribeMediaBytes(bytes, meta.mimeType, meta.filename, req.signal);
		if (result.transcript) {
			stores.mediaStore.updateMediaTranscript(body.chatId, body.mediaId, result.transcript);
		}
		return Response.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ available: false, transcript: null, error: "Could not read media file" }, { status: 200 });
	}
}

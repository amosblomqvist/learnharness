import { groqTranscribeResponse } from "@/src/server";

/** Groq (Whisper) dictation: chunks are uploaded through the local server so the
 * key never reaches the browser. Logic and trust model: src/server/groq-stt.ts. */
export const dynamic = "force-dynamic";

/** Multipart `audio` (WAV) + `model` + `language` + optional `prompt` in, `{ text }` out. */
export async function POST(request: Request) {
	return groqTranscribeResponse(request);
}

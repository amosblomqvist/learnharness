import { groqDictationReadyResponse, groqTranscribeResponse } from "@/src/server";

/** Groq (Whisper) dictation: record-then-upload through the local server so
 * the key never reaches the browser. Logic and trust model: src/server/groq-stt.ts. */
export const dynamic = "force-dynamic";

/** Is a Groq key configured? (No Groq request.) */
export async function GET(request: Request) {
	return groqDictationReadyResponse(request);
}

/** Multipart `audio` (WAV) + `model` + `language` in, `{ text }` out. */
export async function POST(request: Request) {
	return groqTranscribeResponse(request);
}

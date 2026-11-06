import { localTranscribeResponse } from "@/src/server";

/** On-device dictation: a WAV chunk is transcribed by the chosen downloaded model.
 * Logic and trust model: src/server/local-stt/http.ts. */
export const dynamic = "force-dynamic";

/** Multipart `audio` (WAV) + `model` + `preferredLanguages` + optional `language`/`chineseOutput` in, `{ text }` out. */
export async function POST(request: Request) {
	return localTranscribeResponse(request);
}

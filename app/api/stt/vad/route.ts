import { vadResponse } from "@/src/server";

/** Voice activity: Silero's speech probability for every 512-sample frame of a WAV.
 * Used for Groq and Local dictation. Logic and trust model: src/server/local-stt/http.ts. */
export const dynamic = "force-dynamic";

/** Multipart `audio` (WAV) in, `{ probs }` out. */
export async function POST(request: Request) {
	return vadResponse(request);
}

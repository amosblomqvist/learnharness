/**
 * POST /api/tts — read aloud (ElevenLabs voice slice 6): `{ text, voiceId?,
 * modelId? }` in, the provider's MP3 stream out. The key stays server-side;
 * the proxy, defaults and error mapping live in src/server/tts.ts.
 */
import { speak } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body: unknown = await request.json().catch(() => undefined);
	return speak(body);
}

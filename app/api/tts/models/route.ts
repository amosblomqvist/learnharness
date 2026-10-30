/**
 * GET /api/tts/models — the account's text-to-speech models (ElevenLabs voice
 * slice 9): `[{ id, name, maxChars }]`, cached in memory for a few minutes.
 * Keyless 503, upstream 502; see src/server/tts.ts.
 */
import { listTtsModels } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return listTtsModels();
}

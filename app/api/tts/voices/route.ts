/**
 * GET /api/tts/voices — the account's read-aloud voices (ElevenLabs voice
 * slice 9): `[{ id, name, category }]`, every page followed. Keyless 503,
 * upstream 502; see src/server/tts.ts.
 */
import { listTtsVoices } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return listTtsVoices();
}

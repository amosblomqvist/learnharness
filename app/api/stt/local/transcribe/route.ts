/** POST /api/stt/local/transcribe — raw mono 16 kHz s16le PCM in, {text} out. */
import { localSttTranscribeResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
	return localSttTranscribeResponse(req);
}

/** Local dictation: one recorded clip in, its transcript out. The clip is
 * forwarded to the OpenAI-compatible endpoint configured in Settings. */
import { transcribeLocalRequest } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
	return transcribeLocalRequest(request);
}

import { localModelsResponse } from "@/src/server";

/** On-device dictation: installed and downloading models, plus the hardware tier.
 * Polled while a download runs. Logic and trust model: src/server/local-stt/http.ts. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return localModelsResponse(request);
}

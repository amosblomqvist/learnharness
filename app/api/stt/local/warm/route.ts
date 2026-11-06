import { localWarmResponse } from "@/src/server";

/** On-device dictation: load the chosen model before the first chunk arrives.
 * Logic and trust model: src/server/local-stt/http.ts. */
export const dynamic = "force-dynamic";

/** JSON `{ model }` in, `{ model }` out once it is loaded. */
export async function POST(request: Request) {
	return localWarmResponse(request);
}

/** GET /api/stt/local — which engine dictation will use and the on-device model's state. */
import { localSttStatusResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return localSttStatusResponse();
}

/**
 * GET /api/hold — the active host hold (core/host-hold.ts), if any, plus
 * the running work list. The app banner reads it on first paint and after
 * each "hold-changed" event.
 */
import { holdSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(holdSnapshot(), { headers: { "Cache-Control": "no-store" } });
}

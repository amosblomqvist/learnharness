/**
 * GET /api/search — the search engines' status (search wave, 2026-09-20):
 * the honest availability signal the settings UI explains from (the
 * gray-out affordance) and any client surface can read.
 *
 * { available, engine, reason, keyless } — never a key, never a secret:
 * `engine` is the ACTIVE engine when live (auto-detection or the explicit
 * pin), `reason` is the one-line state explanation (missing search API key
 * or pinned-engine-unusable case), and `keyless` says whether each engine
 * that needs no key could run on the saved settings.
 */

import { searchStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(searchStatus());
}

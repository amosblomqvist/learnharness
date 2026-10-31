import { withUser } from "@/src/server/auth/context.ts";
/**
 * GET /api/search — the search engines' status (search wave, 2026-09-20):
 * the honest availability signal the settings UI explains from (the
 * gray-out affordance) and any client surface can read.
 *
 * { available, engine, reason } — never a key, never a secret: `engine` is
 * the ACTIVE engine when live (auto-detection or the explicit pin), and
 * `reason` is the one-line state explanation ("set a Tavily or Brave
 * search API key", or the pinned-engine-key-missing case).
 */

import { searchStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withUser(async function GET() {
	return Response.json(searchStatus());
});

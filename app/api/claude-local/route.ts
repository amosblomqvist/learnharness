import { claudeLocalControlsResponse } from "@/src/server";

/** The Local Claude route's status (GET) and re-check (POST {op:"probe"}) —
 *  same-origin controls over the server's own detection; the settings
 *  themselves are written through PUT /api/settings/claudeLocal. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = claudeLocalControlsResponse;
export const POST = claudeLocalControlsResponse;

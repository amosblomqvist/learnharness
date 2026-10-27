/**
 * GET /api/activity — the dock's one poll: every running background
 * process, every view (chat, home, everywhere). Composition only — the
 * feed lives in server/observability.ts; costs are projected server-side
 * through Pi's catalog and public calculator. See that module's header for why /api/jobs stays
 * chat-scoped and untouched.
 */
import { activityFeed, withUser } from "@/src/server";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request) {
	return Response.json(activityFeed());
}

export const GET = withUser(handleGET);

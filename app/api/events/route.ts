import { withUser } from "@/src/server/auth/context.ts";
/**
 * THE NOTIFICATION CHANNEL ROUTE (push-architecture slice 1, 2026-10-02):
 * one SSE connection per open window over the core event bus — the
 * endpoint every future consumer (chat view, sidebar, activity dock)
 * subscribes to as the polls retire. The response plumbing lives in the
 * server seam (events-stream.ts); the framework route stays a thin
 * wrapper (the import law; tests drive the seam directly).
 */
import { eventsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withUser(async function GET() {
	return eventsResponse();
});

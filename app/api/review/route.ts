/**
 * GET /api/review — the scheduled-practice queue (spaced repetition,
 * 2026-11-02): how many practiced propositions are due, how many new ones
 * today's allowance admits, and the next review session's picks (name +
 * statement, the graph-context marker's shape). The first read in a
 * process backfills the log from existing practice chats.
 */
import { ensureReviewBackfill, reviewSummary } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	ensureReviewBackfill();
	return Response.json(reviewSummary());
}

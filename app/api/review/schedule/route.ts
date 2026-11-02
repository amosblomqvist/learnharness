/**
 * GET /api/review/schedule — the Settings > Review heatmap (2026-11-02):
 * 26 weeks of review activity behind today and the FSRS due dates ahead,
 * scheduled with the current review settings. Like GET /api/review, the
 * first read in a process backfills the log from existing practice chats.
 */
import { ensureReviewBackfill, reviewScheduleView } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	ensureReviewBackfill();
	return Response.json(reviewScheduleView());
}

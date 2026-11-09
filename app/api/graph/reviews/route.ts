import { reviewStatus } from "@/src/server";

/**
 * GET /api/graph/reviews — the retention due surface (issue #33): how many
 * propositions are due for review and which (id/name/statement, current
 * retrievability, dueAt — most overdue first). Thin transport over the pure
 * derivation (core/retention.ts); the home review affordance polls this.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(reviewStatus());
}

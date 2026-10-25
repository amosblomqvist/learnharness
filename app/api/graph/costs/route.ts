/**
 * GET /api/graph/costs — the graph view's cost pill (2026-09 graph cost
 * metrics wave): what the graph PIPELINE cost, folded read-time from the
 * three usage channels (chat extraction runs, notes-source runs,
 * cluster-naming runs). Thin transport over src/server's graphCosts();
 * the fold itself is pure core (core/cost-summary.ts). Dollars are
 * inferred from Pi's catalog/calculator at read time — never stored, so a catalog update
 * re-prices the whole history for free.
 *
 * Scope (user-decided): the graph pipeline ONLY — teaching turns and
 * sub-agent jobs have their own cost channels elsewhere.
 */
import { graphCosts } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(graphCosts());
}

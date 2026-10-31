import { withUser } from "@/src/server/auth/context.ts";
import { graphView } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

export const GET = withUser(async function GET() {
	return Response.json(graphView());
});

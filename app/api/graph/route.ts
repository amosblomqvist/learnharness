import { graphView, withUser } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 */

export const dynamic = "force-dynamic";

async function handleGET(_req: Request) {
	return Response.json(graphView());
}

export const GET = withUser(handleGET);

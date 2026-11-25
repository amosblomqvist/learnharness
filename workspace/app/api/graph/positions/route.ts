/**
 * PUT /api/graph/positions — the live-physics drag commit. The client
 * anneals a drag to rest and sends the new positions; the server
 * sanitizes (finite coords, known ids only), writes the ledger, and if
 * the graph grew mid-drag runs one incremental settle to absorb the new
 * nodes with the client's arrangement as anchors. See
 * src/server/commit-positions.ts.
 *
 *   PUT → 200 {positions: {...}} with whatever survived sanitizing
 *         (empty object = nothing written).
 */
import { commitPositions } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	return Response.json({ positions: commitPositions(body) });
}

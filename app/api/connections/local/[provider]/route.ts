/**
 * POST /api/connections/local/:provider — one control action on a local
 * agent connection (docs/architecture.md §8.2): refresh | enable |
 * consent | signIn | cancelSignIn. Sign-in (Antigravity) runs inside the
 * vendor runtime, which opens the browser itself; the response returns at
 * once with `pending` set and the client polls GET for the outcome.
 */
import { applyLocalAgentAction, isLocalAgentId, parseLocalAgentAction } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function POST(req: Request, { params }: Params) {
	const { provider } = await params;
	if (!isLocalAgentId(provider)) return Response.json({ error: `unknown connection "${provider}"` }, { status: 404 });
	let body: unknown;
	try { body = await req.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
	const action = parseLocalAgentAction(body);
	if (!action) return Response.json({ error: "unknown or malformed action" }, { status: 400 });
	try { return Response.json({ statuses: await applyLocalAgentAction(provider, action) }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
}

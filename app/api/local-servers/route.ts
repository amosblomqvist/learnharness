/**
 * GET /api/local-servers — the configured local model servers (local-models
 * wave, 2026-10-24), each with its display address, whether a key is stored
 * (never the key), and its last discovery: the models it serves with their
 * context windows and capabilities, the ones hidden and why, or the error
 * from the last attempt. `?refresh=1` asks every stale server again first
 * (the settings view); without it the answer is instant (the pill's read).
 *
 * POST /api/local-servers — connect a server (body: LocalServerInput; with
 * `id` = update that server). The server is asked for its models BEFORE
 * anything is stored: 200 {server} when it answered with at least one
 * usable model, 400 for a malformed body or address, 404 for an unknown
 * id, 502 with the user-facing reason when the server could not be used.
 */
import { connectLocalServer, listLocalServers, refreshLocalServers } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	if (new URL(req.url).searchParams.get("refresh") === "1") await refreshLocalServers();
	return Response.json({ servers: listLocalServers() });
}

export async function POST(req: Request) {
	const body = await req.json().catch(() => null);
	const result = await connectLocalServer(body);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ server: result.server });
}

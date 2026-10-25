import { ACP_AGENTS } from "@/src/core";
import { connectAcp, disconnectAcp, localAcpRequest } from "@/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
	if (!localAcpRequest(request) || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Use npm run app; a same-origin local JSON request is required" }, { status: 403 });
	const { id } = await context.params;
	const agent = ACP_AGENTS.find((agent) => agent.id === id);
	if (!agent) return Response.json({ error: "Unknown ACP agent" }, { status: 404 });
	const body: unknown = await request.json().catch(() => null);
	const result = await connectAcp(agent.id, body, request.signal);
	return Response.json(result, { status: result.ok ? 200 : result.status });
}

export async function DELETE(request: Request, context: Context) {
	if (!localAcpRequest(request)) return Response.json({ error: "A same-origin local app request is required" }, { status: 403 });
	const { id } = await context.params;
	const agent = ACP_AGENTS.find((agent) => agent.id === id);
	if (!agent) return Response.json({ error: "Unknown ACP agent" }, { status: 404 });
	await disconnectAcp(agent.id);
	return Response.json({ ok: true });
}

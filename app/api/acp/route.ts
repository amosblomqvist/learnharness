import { acpConnections } from "@/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
	return Response.json({ connections: acpConnections() });
}

import { readPluginCatalog } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
	const result = await readPluginCatalog();
	return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

import { communityPluginCatalog } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
	return communityPluginCatalog.install((await context.params).id, request);
}

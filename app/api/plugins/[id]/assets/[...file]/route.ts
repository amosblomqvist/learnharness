import { pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string; file: string[] }> }) {
	const { id, file } = await context.params;
	return pluginTransport.asset(id, file);
}

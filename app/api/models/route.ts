import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). The shipped
 * rows are static within a pi-ai version; OpenRouter's list is refreshed
 * from its live endpoint (TTL-cached, best-effort) so models newer than the
 * bundled snapshot still appear.
 */
export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}

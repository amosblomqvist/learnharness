import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog: no network, stable within a pi-ai version.
 */
export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}

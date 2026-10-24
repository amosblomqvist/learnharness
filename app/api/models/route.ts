import { modelCatalog, refreshLocalServers } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). The hosted
 * catalogs are static (no network, stable within a pi-ai version); local
 * servers (local-models wave) are asked for their models first, at most
 * once per LOCAL_DISCOVERY_TTL_MS — a model pulled a moment ago appears on
 * the picker's next open.
 */
export async function GET() {
	await refreshLocalServers();
	return Response.json(modelCatalog());
}

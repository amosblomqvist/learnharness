import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap).
 *
 * pi-ai's builtin catalogs are static; Command Code's live catalog refreshes
 * in the background here (TTL-gated), so this request serves the last-known
 * snapshot and the next one sees the update.
 */
export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}

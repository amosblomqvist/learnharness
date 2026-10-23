/**
 * Custom provider connections (metadata + dedicated key).
 *
 *   GET    → 200 {providers: CustomProviderStatus[]}   (keyPresent only, never a key)
 *   PUT    {provider: CustomProviderDefinition, apiKey?} → 200 {provider: CustomProviderStatus}
 *   DELETE {id} → 200 {deleted: true}
 *
 * Mutations are same-origin guarded and capped at 64 KiB. Handlers live in
 * src/server/custom-providers.ts. Needs the server barrel to export
 * connectionGuard and customProvidersHandlers.
 */
import { connectionGuard, customProvidersHandlers } from "@/src/server";

export const dynamic = "force-dynamic";

const handlers = customProvidersHandlers();

export async function GET(request: Request) {
	return connectionGuard(request, false) ?? handlers.get();
}
export async function PUT(request: Request) {
	return connectionGuard(request) ?? handlers.put(request);
}
export async function DELETE(request: Request) {
	return connectionGuard(request) ?? handlers.delete(request);
}

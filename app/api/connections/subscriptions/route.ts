/**
 * GET /api/connections/subscriptions — subscription connection status.
 * DELETE — disconnect one ({providerId}). Loopback + same-origin guarded;
 * DTOs only, never credentials. Status reads the store only (no refresh).
 */
import {
	ConnectionError,
	connectionErrorResponse,
	connectionGuard,
	disconnectSubscription,
	listSubscriptionStatuses,
	noStoreJson,
	readJsonBody,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const denied = connectionGuard(request, false);
	if (denied) return denied;
	try {
		return noStoreJson({ subscriptions: await listSubscriptionStatuses() });
	} catch (err) {
		return connectionErrorResponse(err);
	}
}

export async function DELETE(request: Request) {
	const denied = connectionGuard(request);
	if (denied) return denied;
	try {
		const body = await readJsonBody(request);
		if (typeof body.providerId !== "string") throw new ConnectionError(400, "providerId is required.");
		await disconnectSubscription(body.providerId);
		return noStoreJson({ subscriptions: await listSubscriptionStatuses() });
	} catch (err) {
		return connectionErrorResponse(err);
	}
}

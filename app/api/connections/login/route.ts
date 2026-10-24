/**
 * POST /api/connections/login {providerId} — start a subscription login
 * attempt; returns a LoginAttemptView. Guarded (loopback, same-origin,
 * X-LearnHarness-Connections: 1).
 */
import {
	ConnectionError,
	connectionErrorResponse,
	connectionGuard,
	noStoreJson,
	readJsonBody,
	startSubscriptionLogin,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const denied = connectionGuard(request);
	if (denied) return denied;
	try {
		const body = await readJsonBody(request);
		if (typeof body.providerId !== "string") throw new ConnectionError(400, "providerId is required.");
		return noStoreJson(await startSubscriptionLogin(body.providerId));
	} catch (err) {
		return connectionErrorResponse(err);
	}
}

import { subscriptionRequestOrigin } from "./desktop-access.ts";
import { cloudControl, cloudSyncStatus, completeCloudSignIn } from "./cloud-sync.ts";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export async function cloudControlsResponse(request: Request): Promise<Response> {
	try {
		if (request.method === "GET") return Response.json(cloudSyncStatus(), { headers });
		const origin = subscriptionRequestOrigin(request);
		if (!origin || request.headers.get("origin") !== origin || request.headers.get("x-learnharness-cloud") !== "1"
			|| request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "Open cloud account controls from LearnHarness." }, { status: 403, headers });
		if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return Response.json({ error: "Expected JSON." }, { status: 415, headers });
		const raw = await request.text();
		if (raw.length > 2048) return Response.json({ error: "Request too large." }, { status: 413, headers });
		const body = JSON.parse(raw) as { op?: unknown; enabled?: unknown };
		if (!body || typeof body.op !== "string") throw new Error("Invalid account operation.");
		return Response.json(await cloudControl(body.op, origin, body.enabled), { headers });
	} catch (error) {
		const message = error instanceof Error && /^(Wait for|A sync or|Choose whether|Unsupported cloud|Enable Google|Sign out before|Configure LH_CONVEX_URL|Invalid account)/.test(error.message)
			? error.message : "Could not connect or sync. Check your connection and the Convex Google sign-in setup, then retry.";
		return Response.json({ error: message }, { status: 409, headers });
	}
}
export async function cloudCallbackResponse(request: Request): Promise<Response> {
	let success = false;
	try { await completeCloudSignIn(new URL(request.url)); success = true; }
	catch { /* Public response must never contain callback codes, tokens or URLs. */ }
	return new Response(success ? "Google account connected. You can close this tab and return to LearnHarness."
		: "Google sign-in could not be completed. Return to LearnHarness → Settings → Labs and try again. Wait for active sessions to finish first.",
	{ status: success ? 200 : 400, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } });
}

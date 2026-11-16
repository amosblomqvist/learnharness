import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export const EXTERNAL_CLI_INTENT_HEADER = "x-learnharness-external-cli";

/** Same-origin browser intent, not user authentication. No CORS grants.
 * A public/shared server still requires its own access-control boundary.
 * Takes values only; never branches on which CLI it guards. */
export async function externalCliInstallationResponse<T>(
	request: Request,
	{ label, inspect, enabled }: { label: string; inspect: () => Promise<T>; enabled: () => boolean },
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET" || !origin
		|| request.headers.get(EXTERNAL_CLI_INTENT_HEADER) !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: `${label} checks require a same-origin LearnHarness request.` }, { status: 403, headers });
	}
	if (!enabled()) return Response.json({ error: `${label} is disabled.` }, { status: 403, headers });
	return Response.json(await inspect(), { headers });
}

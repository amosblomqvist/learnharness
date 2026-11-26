import { inspectAgyInstallation } from "../agent/agy/installation.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { agyEnabled } from "./agy-config.ts";

export async function agyInstallationStatus() {
	initAuthEnv();
	return inspectAgyInstallation();
}

export async function agyInstallationResponse(
	request: Request,
	inspect = agyInstallationStatus,
	enabled = agyEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET" || !origin
		|| request.headers.get("x-learnharness-agy") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "AGY checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	const runInspect = typeof inspect === "function" ? inspect : agyInstallationStatus;
	const runEnabled = typeof enabled === "function" ? enabled : agyEnabled;
	if (!runEnabled()) return Response.json({ error: "AGY is disabled." }, { status: 403, headers });
	return Response.json(await runInspect(), { headers });
}

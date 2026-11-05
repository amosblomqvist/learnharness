/**
 * Request gate for the local-dictation mutations (issue #15, PR #50):
 * PUT /api/stt/methods, POST and DELETE /api/stt/models/<id>. The same
 * boundary as the custom-endpoint mutations (custom-provider-http.ts):
 * the desktop server requires its API capability; web/dev requires a
 * same-origin request carrying a JSON content type, so a cross-site page
 * cannot start a model download with a no-cors POST.
 */
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

function authorized(request: Request): boolean {
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	if (desktop) return desktopAPIAuthorized(request.headers);
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	const site = request.headers.get("sec-fetch-site");
	return origin === subscriptionRequestOrigin(request) && (site === null || site === "same-origin");
}

/** A refusal for a request that may not change dictation state, or null. */
export function dictationMutationRefusal(request: Request): Response | null {
	if (!authorized(request)) {
		return Response.json({ error: "Dictation changes require a same-origin LearnHarness request." }, { status: 403 });
	}
	const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json") return Response.json({ error: "JSON content-type is required." }, { status: 415 });
	return null;
}

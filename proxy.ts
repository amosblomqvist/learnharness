import { NextResponse, type NextRequest } from "next/server";
import { browserAPIRefusal, browserOnlyMode, desktopAPIAuthorized } from "./src/server/desktop-access.ts";

function refuse(error: string) {
	return NextResponse.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 * Browser-only mode has no secret, so it gets the Host and cross-site checks. */
export function proxy(request: NextRequest) {
	if (browserOnlyMode()) {
		const refusal = browserAPIRefusal(request);
		if (refusal) return refuse(refusal);
		return NextResponse.next();
	}
	if (!desktopAPIAuthorized(request.headers)) {
		return refuse("Desktop API access requires the trusted LearnHarness window.");
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };

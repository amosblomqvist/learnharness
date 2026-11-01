import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { appsOnlyAllowed, appsOnlyRefusal, isPublicPath, remoteRequestAuthorized, serverModeEnabled } from "./src/server/remote-access.ts";

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * (server mode included) inside its handler, avoiding Next's silently
 * truncated Proxy body clone. No public callback or worker bypass: legitimate
 * self-HTTP still needs the capability.
 *
 * Server mode (LH_SERVER_PASSWORD set, src/server/remote-access.ts) also
 * gates pages: signed-out browsers are sent to /login, signed-out API calls
 * get 401. With LH_APPS_ONLY=1 on top, anything that isn't the desktop or
 * iPhone app is refused before sign-in. Without server mode, pages pass
 * straight through as before. */
export function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	const api = pathname === "/api" || pathname.startsWith("/api/");
	if (!appsOnlyAllowed(request.headers)) return appsOnlyRefusal(api);
	if (serverModeEnabled() && !isPublicPath(pathname) && !remoteRequestAuthorized(request.headers)) {
		if (api) {
			return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
		}
		const login = new URL("/login", request.url);
		login.searchParams.set("next", pathname + search);
		return NextResponse.redirect(login);
	}
	const refusal = api ? apiRequestRefusal(request) : undefined;
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = {
	// Pages (for server-mode sign-in) and all of /api, except build assets,
	// public files, and the exact streamed document endpoint (it checks the
	// same policy itself). Must remain static literals.
	matcher: ["/((?!_next/static|_next/image|fonts/|worklets/|siwc/|favicon\\.ico|api/plugins/[^/]+/documents/markdown/?$).*)"],
};

import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { readCookie, SESSION_COOKIE, verifySession } from "./src/server/auth/session.ts";
import { countUsers } from "./src/store/users.ts";

/**
 * THE ACCESS GATE (mobile-web, 2026-10-29).
 *
 * Rules, in order:
 *   1. No accounts yet → everything redirects to /setup (first-run claim).
 *   2. Desktop shell (capability header) → allowed everywhere, no login screen.
 *   3. Valid session cookie → allowed; /login, /setup and /join bounce home.
 *   4. Otherwise → 401 JSON for the API, /login for pages.
 *
 * API routes ALSO wrap their handlers in withUser() (defense in depth): this
 * gate decides UX, the handler decides data-scope.
 */

const PUBLIC_PAGES = new Set(["/login", "/setup", "/join"]);

async function hasSession(request: NextRequest): Promise<boolean> {
	const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
	if (!token) return false;
	return (await verifySession(token)) !== null;
}

export async function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	const isApi = pathname === "/api" || pathname.startsWith("/api/");
	const isAuthApi = pathname.startsWith("/api/auth/");
	const desktop = process.env.LH_DESKTOP_SERVER === "1" && desktopAPIAuthorized(request.headers);
	const initialized = countUsers() > 0;

	if (!initialized) {
		if (isApi) {
			if (isAuthApi) return NextResponse.next();
			return NextResponse.json(
				{ error: "setup_required", message: "Create the first account to use this server." },
				{ status: 503, headers: { "Cache-Control": "no-store" } },
			);
		}
		if (pathname === "/setup") return NextResponse.next();
		return NextResponse.redirect(new URL("/setup", request.url));
	}

	const signedIn = desktop || (await hasSession(request));
	if (signedIn) {
		if (PUBLIC_PAGES.has(pathname)) return NextResponse.redirect(new URL("/", request.url));
		return NextResponse.next();
	}

	if (isAuthApi) return NextResponse.next();
	// Public pages must pass for anonymous visitors too — otherwise /login
	// redirects to /login?next=/login and the browser reports "too many
	// redirects" (bug found in the first live run, 2026-10-29).
	if (PUBLIC_PAGES.has(pathname)) return NextResponse.next();
	if (isApi) {
		return NextResponse.json(
			{ error: "unauthorized", message: "Sign in to continue." },
			{ status: 401, headers: { "Cache-Control": "no-store" } },
		);
	}
	const login = new URL("/login", request.url);
	if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
	return NextResponse.redirect(login);
}

export const config = {
	// Static assets, icons and the manifest stay public — a login redirect on a
	// stylesheet would leave the login page itself unstyled.
	matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)"],
};

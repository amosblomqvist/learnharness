/**
 * Request identity + data scope (mobile-web, 2026-10-29).
 *
 * `withUser()` is the ONE way a route handler gets an authenticated account:
 * it resolves the session cookie (or the desktop shell's capability header),
 * enters the account's data scope, and only then runs the handler. Everything
 * the handler spawns — services, turn runs, sub-agent jobs — inherits the
 * scope through AsyncLocalStorage (src/server/scope.ts).
 *
 * Failure is loud and early: no scope ⇒ 401, never a silent write into the
 * shared base data root.
 */

import { cookies } from "next/headers";
import { desktopAPIAuthorized } from "../desktop-access.ts";
import { ownerAccount, getUserById } from "../../store/users.ts";
import { BASE_DATA, userDataRoot } from "../../../config.ts";
import { currentScope, runInScope, type DataScope, type UserRole } from "../scope.ts";
import { readCookie, SESSION_COOKIE, verifySession } from "./session.ts";

export type AuthUser = { id: string; name: string; email: string; role: UserRole };

function scopeForAccount(account: { id: string; email: string; role: UserRole }): DataScope {
	return { userId: account.id, email: account.email, role: account.role, dataRoot: userDataRoot(account.id) };
}

/** The pre-auth identity: legacy behavior, base data root (scripts/tests/first boot). */
function localScope(): DataScope {
	return { userId: "local", email: "local@localhost", role: "admin", dataRoot: BASE_DATA };
}

async function cookieToken(request?: Request): Promise<string | null> {
	if (request) return readCookie(request.headers.get("cookie"), SESSION_COOKIE);
	try {
		const jar = await cookies();
		return jar.get(SESSION_COOKIE)?.value ?? null;
	} catch {
		return null;
	}
}

function desktopBypass(request?: Request): boolean {
	if (process.env.LH_DESKTOP_SERVER !== "1") return false;
	return desktopAPIAuthorized(request?.headers ?? new Headers());
}

/**
 * Resolve the request's data scope, or null when the caller is not signed in.
 * The test runner (NODE_ENV=test) keeps the legacy single-root behavior so the
 * existing suite exercises stores and routes exactly as before.
 */
export async function resolveScope(request?: Request): Promise<DataScope | null> {
	if (process.env.NODE_ENV === "test") return localScope();

	if (desktopBypass(request)) {
		const owner = ownerAccount();
		return owner ? scopeForAccount(owner) : localScope();
	}

	const token = await cookieToken(request);
	if (!token) return null;
	const claims = await verifySession(token);
	if (!claims) return null;
	const account = getUserById(claims.sub);
	if (!account || account.disabled) return null;
	if ((account.sessionVersion ?? 1) !== claims.ver) return null;
	return scopeForAccount(account);
}

export function currentUser(): AuthUser | null {
	const scope = currentScope();
	if (!scope) return null;
	return { id: scope.userId, name: scope.userId, email: scope.email, role: scope.role };
}

export function requireAdmin(): boolean {
	return currentScope()?.role === "admin";
}

function unauthorized(): Response {
	return Response.json(
		{ error: "unauthorized", message: "Sign in to continue." },
		{ status: 401, headers: { "Cache-Control": "no-store" } },
	);
}

/**
 * Run SERVER-COMPONENT work inside the signed-in account's scope.
 *
 * Pages are not route handlers: `withUser` never sees them, and Next renders
 * the returned tree after the page function returns, so wrapping the JSX does
 * not cover descendants. What the page ITSELF reads (getChat,
 * readSettingsRecord, liveness) must run inside the scope — otherwise it reads
 * the empty base root and notFound() a chat that exists (bug found live,
 * 2026-10-29: page 404 while /api/chats/<id> answered 200).
 *
 * Client children keep using the API, which is scoped by withUser.
 */
export async function withUserScope<T>(fn: () => T | Promise<T>): Promise<T> {
	const scope = await resolveScope();
	if (!scope) return fn();
	return runInScope(scope, fn);
}

/**
 * Wrap an exported route handler: resolve the account, enter its scope, run.
 * Handlers keep their exact signatures (including `{ params }` context), so
 * Next's calling convention and the existing route tests are untouched.
 */
export function withUser<A extends unknown[]>(
	handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
	return async (...args: A): Promise<Response> => {
		const request = args[0] instanceof Request ? (args[0] as Request) : undefined;
		const scope = await resolveScope(request);
		if (!scope) return unauthorized();
		return runInScope(scope, () => handler(...args));
	};
}

/**
 * Shared HTTP helpers for the auth routes (mobile-web, 2026-10-29).
 */

import type { AccountRecord } from "../../store/users.ts";
import { publicAccount, type PublicAccount } from "./accounts.ts";
import { isSecureRequest, sessionCookie, signSession } from "./session.ts";

export function jsonError(message: string, status: number): Response {
	return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Sign the account in: returns the JSON body plus the Set-Cookie header. */
export async function signedInResponse(
	account: AccountRecord,
	request: Request,
): Promise<Response> {
	const token = await signSession({
		sub: account.id,
		email: account.email,
		role: account.role,
		ver: account.sessionVersion ?? 1,
	});
	const body: { ok: true; user: PublicAccount } = { ok: true, user: publicAccount(account) };
	return Response.json(body, {
		headers: {
			"Set-Cookie": sessionCookie(token, isSecureRequest(request)),
			"Cache-Control": "no-store",
		},
	});
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	const body = (await request.json().catch(() => null)) as unknown;
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

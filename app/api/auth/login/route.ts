/**
 * POST /api/auth/login — email + password → session cookie (mobile-web).
 */

import { authenticate, loginBlocked } from "@/src/server/auth/accounts.ts";
import { jsonError, readJson, signedInResponse } from "@/src/server/auth/http.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = await readJson(request);
	const email = typeof body.email === "string" ? body.email : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!email || !password) return jsonError("Enter your email and password.", 400);
	if (loginBlocked(email)) return jsonError("Too many attempts. Try again in a minute.", 429);
	const account = await authenticate(email, password);
	if (!account) return jsonError("Email or password is incorrect.", 401);
	return signedInResponse(account, request);
}

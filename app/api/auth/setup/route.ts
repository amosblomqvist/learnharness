/**
 * POST /api/auth/setup — first-run admin creation (mobile-web, 2026-10-29).
 * Public by design, but only while no account exists: once the registry has
 * one user this route refuses forever (409), so a tunnel-exposed server cannot
 * be claimed by a stranger once it is configured.
 */

import { countUsers } from "@/src/store/users.ts";
import { createFirstAdmin, validateCredentials } from "@/src/server/auth/accounts.ts";
import { jsonError, readJson, signedInResponse } from "@/src/server/auth/http.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (countUsers() > 0) return jsonError("already_initialized", 409);
	const body = await readJson(request);
	const parsed = validateCredentials(body);
	if ("error" in parsed) return jsonError(parsed.error, 400);
	try {
		const account = await createFirstAdmin(parsed);
		return await signedInResponse(account, request);
	} catch (err) {
		if (err instanceof Error && err.message === "already_initialized") return jsonError("already_initialized", 409);
		if (err instanceof Error && err.message === "email_taken") return jsonError("That email is already in use.", 409);
		return jsonError("Could not create the account.", 500);
	}
}

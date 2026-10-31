/**
 * POST /api/auth/join — accept an invite (mobile-web, 2026-10-29).
 * The invite decides the role and, when it pins one, the email.
 */

import { joinWithInvite, validateCredentials } from "@/src/server/auth/accounts.ts";
import { jsonError, readJson, signedInResponse } from "@/src/server/auth/http.ts";
import { pendingInvite } from "@/src/store/users.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = await readJson(request);
	const code = typeof body.code === "string" ? body.code.trim() : "";
	if (!code) return jsonError("This invite link is incomplete.", 400);
	const invite = pendingInvite(code);
	if (!invite) return jsonError("This invite is invalid or has expired.", 410);
	const parsed = validateCredentials({
		name: body.name,
		email: invite.email ?? body.email,
		password: body.password,
	});
	if ("error" in parsed) return jsonError(parsed.error, 400);
	try {
		const account = await joinWithInvite({ code, ...parsed, email: invite.email ?? parsed.email });
		if (!account) return jsonError("This invite was already used.", 410);
		return await signedInResponse(account, request);
	} catch (err) {
		if (err instanceof Error && err.message === "email_taken") return jsonError("That email is already in use.", 409);
		return jsonError("Could not create the account.", 500);
	}
}

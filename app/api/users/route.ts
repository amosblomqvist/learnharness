/**
 * /api/users — the account list and admin-side creation (mobile-web).
 * Admin only: every handler refuses non-admins with 403.
 */

import { requireAdmin, withUser } from "@/src/server/auth/context.ts";
import { createUserByAdmin, publicAccount, validateCredentials } from "@/src/server/auth/accounts.ts";
import { jsonError, readJson } from "@/src/server/auth/http.ts";
import { createInvite, listAccounts, listInvites } from "@/src/store/users.ts";

export const dynamic = "force-dynamic";

export const GET = withUser(async () => {
	if (!requireAdmin()) return jsonError("Admins only.", 403);
	return Response.json({
		users: listAccounts().map(publicAccount),
		invites: listInvites(),
	});
});

export const POST = withUser(async (request: Request) => {
	if (!requireAdmin()) return jsonError("Admins only.", 403);
	const body = await readJson(request);
	const role = body.role === "admin" ? "admin" : "user";

	// Invite mode: hand back a link the invitee uses to set their own password.
	if (body.invite === true) {
		const email = typeof body.email === "string" && body.email.trim() ? body.email : undefined;
		const invite = createInvite({ role, createdBy: "admin", ...(email ? { email } : {}) });
		const origin = new URL(request.url).origin;
		return Response.json({
			invite,
			url: `${origin}/join?code=${encodeURIComponent(invite.code)}`,
		});
	}

	// Direct mode: admin sets the first password.
	const parsed = validateCredentials({ name: body.name, email: body.email, password: body.password });
	if ("error" in parsed) return jsonError(parsed.error, 400);
	try {
		const account = await createUserByAdmin({ ...parsed, role });
		return Response.json({ user: publicAccount(account) }, { status: 201 });
	} catch (err) {
		if (err instanceof Error && err.message === "email_taken") return jsonError("That email is already in use.", 409);
		return jsonError("Could not create the account.", 500);
	}
});

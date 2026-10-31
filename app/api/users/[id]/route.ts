/**
 * /api/users/[id] — admin-side account edits (mobile-web): rename, reset
 * password, promote/demote, disable, delete. The last admin can neither be
 * demoted, disabled nor deleted.
 */

import { requireAdmin, withUser } from "@/src/server/auth/context.ts";
import { deleteUserAccount, publicAccount, resetPassword, setDisabled } from "@/src/server/auth/accounts.ts";
import { jsonError, readJson } from "@/src/server/auth/http.ts";
import { adminCount, getUserById, updateAccount } from "@/src/store/users.ts";
import { currentScope } from "@/src/server/scope.ts";
import { MIN_PASSWORD_LENGTH } from "@/src/server/auth/password.ts";

export const dynamic = "force-dynamic";

export const PATCH = withUser(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	if (!requireAdmin()) return jsonError("Admins only.", 403);
	const { id } = await params;
	const account = getUserById(id);
	if (!account) return jsonError("Account not found.", 404);
	const body = await readJson(request);

	if (typeof body.name === "string" && body.name.trim()) {
		updateAccount(id, { name: body.name });
	}
	if (typeof body.password === "string") {
		if (body.password.length < MIN_PASSWORD_LENGTH) return jsonError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
		await resetPassword(id, body.password);
	}
	if (body.role === "admin" || body.role === "user") {
		if (account.role === "admin" && body.role === "user" && adminCount() <= 1) {
			return jsonError("There must be at least one admin.", 409);
		}
		updateAccount(id, { role: body.role });
	}
	if (typeof body.disabled === "boolean") {
		if (id === currentId()) return jsonError("You cannot disable your own account.", 409);
		if (!setDisabled(id, body.disabled)) return jsonError("There must be at least one admin.", 409);
	}
	const updated = getUserById(id);
	return Response.json({ user: updated ? publicAccount(updated) : null });
});

export const DELETE = withUser(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
	if (!requireAdmin()) return jsonError("Admins only.", 403);
	const { id } = await params;
	if (id === currentId()) return jsonError("You cannot delete your own account.", 409);
	if (!deleteUserAccount(id)) return jsonError("Could not delete this account (missing or last admin).", 409);
	return Response.json({ ok: true });
});

/** The caller's own account id, from the request scope. */
function currentId(): string | null {
	return currentScope()?.userId ?? null;
}

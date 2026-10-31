/**
 * GET /api/auth/me — the signed-in account (or null). Public: the login page
 * and the client shell both call it to know where they stand.
 */

import { resolveScope } from "@/src/server/auth/context.ts";
import { getUserById } from "@/src/store/users.ts";
import { publicAccount } from "@/src/server/auth/accounts.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const scope = await resolveScope(request);
	if (!scope) return Response.json({ user: null }, { headers: { "Cache-Control": "no-store" } });
	const account = getUserById(scope.userId);
	const user = account
		? publicAccount(account)
		: { id: scope.userId, name: "Local", email: scope.email, role: scope.role, createdAt: "", disabled: false };
	return Response.json({ user }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/auth/logout — clear the session cookie (mobile-web).
 */

import { clearSessionCookie, isSecureRequest } from "@/src/server/auth/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return Response.json(
		{ ok: true },
		{
			headers: {
				"Set-Cookie": clearSessionCookie(isSecureRequest(request)),
				"Cache-Control": "no-store",
			},
		},
	);
}

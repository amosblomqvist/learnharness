/**
 * The profile list + sign-up (multi-user profiles, 2026-10-27). Open
 * without a session: the select screen reads and posts here. Creating
 * from the select screen signs the browser in as the new profile; the
 * first profile becomes the admin and claims the install.
 */
import { createProfile, sessionCookieHeader, usersErrorResponse, usersSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
	return Response.json(usersSnapshot(req));
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { name?: unknown; color?: unknown; pin?: unknown };
	try {
		const { profile, sessionId } = createProfile(req, body);
		const headers = sessionId ? { "Set-Cookie": sessionCookieHeader(sessionId) } : undefined;
		return Response.json({ profile, signedIn: sessionId !== null }, { status: 201, headers });
	} catch (err) {
		return usersErrorResponse(err);
	}
}

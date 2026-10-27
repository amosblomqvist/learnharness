/**
 * Open a profile (POST {id, pin?}) or change user (DELETE). The PIN only
 * gates opening the profile through the app.
 */
import {
	clearedSessionCookieHeader,
	endSession,
	sessionCookieHeader,
	unlockProfile,
	usersErrorResponse,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { id?: unknown; pin?: unknown };
	try {
		const sessionId = unlockProfile(body.id, body.pin);
		return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookieHeader(sessionId) } });
	} catch (err) {
		return usersErrorResponse(err);
	}
}

export function DELETE(req: Request) {
	endSession(req);
	return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookieHeader() } });
}

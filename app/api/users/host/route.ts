/** The admin's install-wide switches: PUT {restrictedSignups}. */
import { setRestrictedSignups, usersErrorResponse, usersSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { restrictedSignups?: unknown };
	try {
		setRestrictedSignups(req, body.restrictedSignups);
		return Response.json({ host: usersSnapshot(req).host });
	} catch (err) {
		return usersErrorResponse(err);
	}
}

/**
 * POST /api/hold/cancel — the banner's Cancel: aborts the active hold's
 * signal (the holder stops its work) and releases the hold. Exempt from the
 * proxy's hold gate. 409 when no hold is active.
 */
import { cancelHold } from "@/src/server";

export async function POST() {
	if (!cancelHold()) return Response.json({ error: "Nothing is holding the app." }, { status: 409 });
	return Response.json({ ok: true });
}

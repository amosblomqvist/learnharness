import { cancelAnalyses } from "@/src/server";

export const dynamic = "force-dynamic";

/** Stop the running/queued analyses (they land as failed: Cancelled). */
export async function POST() {
	cancelAnalyses();
	return Response.json({ ok: true });
}

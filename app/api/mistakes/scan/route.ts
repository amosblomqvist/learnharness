import { countAllNewMistakes, enqueueAnalyses, readMistakes, recordAllMistakes } from "@/src/server";

export const dynamic = "force-dynamic";

/** Scan every saved session for mistakes not recorded yet (the backfill).
 *  Without `confirm` it only COUNTS (no writes, no model calls); with
 *  `confirm: true` it records them and starts their analyses. Failed and
 *  stuck-pending analyses are queued again too (the settings' cost cap still
 *  applies). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
	if (body?.confirm !== true) {
		const found = countAllNewMistakes();
		const retry = readMistakes().filter((r) => r.status !== "ready").length;
		return Response.json({ found, retry });
	}
	const added = recordAllMistakes();
	const redo = readMistakes().filter((r) => r.status !== "ready").map((r) => r.id);
	const toQueue = [...new Set([...added, ...redo])];
	enqueueAnalyses(toQueue);
	return Response.json({ added: added.length, queued: toQueue.length });
}

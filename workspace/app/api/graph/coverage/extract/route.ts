/**
 * POST /api/graph/coverage/extract — the manual extraction affordance
 * (vision-extraction-coverage.md): run the pipeline over ONE session's
 * uncovered content, whatever its size — the user's answer to an aborted
 * run, a pipeline error, or a session that went dormant under the chunk
 * budget. The pipeline itself batches under the graph.extractionChunkTokens setting (extraction-UX redesign,
 * 2026-09-24) and
 * checkpoints coverage per merged batch, so this is the same run the
 * trigger fires, just user-initiated. 409 while a run is already in
 * flight (the dock is the source of truth for that); failures are logged
 * by the pipeline and leave coverage untouched — the button stays honest.
 */
import { extraction, extractionStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = (body as { chatId?: unknown }).chatId;
	if (typeof chatId !== "string" || chatId === "") {
		return Response.json({ error: 'Body must be {chatId: string}' }, { status: 400 });
	}
	if (extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId)) {
		return Response.json({ error: "An extraction run is already in flight for this session" }, { status: 409 });
	}
	// Fire-and-forget, like the trigger: the dock + the coverage panel's
	// running flags track progress; the promise never blocks the response.
	void extraction.runExtraction(chatId).catch((err: unknown) => {
		console.error(`[chat ${chatId}] manual extraction failed:`, err);
	});
	return Response.json({ started: true }, { status: 202 });
}
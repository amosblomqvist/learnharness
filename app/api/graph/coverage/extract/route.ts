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
import { extraction, extractionStatuses, getChat, pluginRecordExtractionEnabled, resolveChatRecord, runRecordExtraction, stores } from "@/src/server";

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
	// Plugin session kinds (stage B) extract into the record their kind names:
	// a plugin record runs its host-chunked raw batches; an unavailable kind
	// or record plugin refuses honestly. Native kinds keep the path below.
	const kind = getChat(chatId)?.kind;
	if (kind !== undefined && kind !== "teach" && kind !== "practice") {
		const target = await resolveChatRecord(kind);
		if (target.status === "unavailable") {
			return Response.json({ error: "The plugin that owns this session's record is disabled or not installed", code: "record-kind-unavailable", recordKindId: target.recordKindId }, { status: 409 });
		}
		if (target.status === "plugin") {
			// Stage C (owner q54): the record's host-owned switch refuses honestly.
			if (!pluginRecordExtractionEnabled(target.recordKindId)) {
				return Response.json({ error: `Extraction into ${target.label} is turned off`, code: "record-extraction-disabled", recordKindId: target.recordKindId }, { status: 409 });
			}
			void runRecordExtraction({ chatStore: stores.chatStore }, chatId, target, "manual").catch((err: unknown) => {
				console.error(`[chat ${chatId}] manual record extraction failed:`, err);
			});
			return Response.json({ started: true }, { status: 202 });
		}
	}
	// Fire-and-forget, like the trigger: the dock + the coverage panel's
	// running flags track progress; the promise never blocks the response.
	void extraction.runExtraction(chatId).catch((err: unknown) => {
		console.error(`[chat ${chatId}] manual extraction failed:`, err);
	});
	return Response.json({ started: true }, { status: 202 });
}
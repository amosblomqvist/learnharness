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
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";
import {
	extraction,
	ExtractionStageUnavailableError,
	formatExtractionError,
	getChat,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Body must be {chatId: string}" }, { status: 400 });
	}
	const chatId = (body as { chatId?: unknown }).chatId;
	if (typeof chatId !== "string" || chatId === "") {
		return Response.json({ error: "Body must be {chatId: string}" }, { status: 400 });
	}
	const record = getChat(chatId);
	if (!record) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}
	if (record.kind === "practice") {
		return Response.json({ error: "Practice sessions do not extract into the knowledge graph." }, { status: 400 });
	}
	try {
		const started = await extraction.startExtraction(chatId);
		if (started.status === "already_running") {
			return Response.json({ error: "An extraction run is already in flight for this session" }, { status: 409 });
		}
		if (started.status === "not_found") {
			return Response.json({ error: "Unknown chat" }, { status: 404 });
		}
		if (started.status === "nothing_uncovered") {
			return Response.json({ started: false }, { status: 200 });
		}
		// Fire-and-forget after synchronous registration: the dock + coverage
		// surfaces observe running=true immediately; catch avoids unhandled rejections.
		void started.done.catch((err: unknown) => {
			console.error(`[chat ${chatId}] manual extraction failed:`, err);
		});
		return Response.json({ started: true }, { status: 202 });
	} catch (err: unknown) {
		if (err instanceof ModelsNotConfiguredError) {
			return Response.json(err.envelope, { status: 503 });
		}
		if (err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		if (err instanceof ExtractionStageUnavailableError) {
			return Response.json({ error: err.message, code: "model_unavailable" }, { status: 503 });
		}
		console.error(`[chat ${chatId}] manual extraction failed to start:`, err);
		return Response.json({ error: formatExtractionError(err) }, { status: 503 });
	}
}
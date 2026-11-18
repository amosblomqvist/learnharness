import { deleteFolderWithSessions, SourceDeletionError } from "@/src/server";
import { emit, type ChatDeleteMode } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/graph/sources/folders/[id]?mode=preserve-graph|delete-nodes —
 * the sidebar's folder Delete: the folder, its subfolders and every session
 * inside; imported notes inside move to the folder's parent. The mode is
 * required, exactly as for single-session deletion. 409/503 are retryable
 * and nothing was deleted.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = new URL(request.url).searchParams.get("mode") as ChatDeleteMode;
	try { return Response.json({ ok: true, ...(await deleteFolderWithSessions(id, mode)) }); }
	catch (error) {
		if (error instanceof SourceDeletionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		return Response.json({ error: "Could not finish deleting the folder. Some sessions may already have been removed; refresh or retry.", code: "error" }, { status: 500 });
	} finally {
		emit("sources-changed", {}); emit("chats-changed", {}); emit("activity-changed", {});
	}
}

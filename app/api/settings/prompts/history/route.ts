import { PROMPT_EDITOR_IDS, type PromptEditorId } from "@/src/core";
import { deletePromptEditorHistory, restorePromptEditor } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = await request.json().catch(() => null) as { editor?: unknown; versionId?: unknown } | null;
	if (!body || !PROMPT_EDITOR_IDS.includes(body.editor as PromptEditorId) || typeof body.versionId !== "string") {
		return Response.json({ error: "body must be {editor: supported editor, versionId: string}" }, { status: 400 });
	}
	try {
		const restored = restorePromptEditor(body.editor as PromptEditorId, body.versionId);
		return restored
			? Response.json(restored)
			: Response.json({ error: "Prompt history entry not found" }, { status: 404 });
	} catch (error) {
		console.error("[prompt history] could not restore", error);
		return Response.json({ error: "Could not restore prompt history" }, { status: 500 });
	}
}

export async function DELETE(request: Request) {
	const body = await request.json().catch(() => null) as { versionIds?: unknown } | null;
	if (!body || (body.versionIds !== undefined && (!Array.isArray(body.versionIds) || !body.versionIds.every((id) => typeof id === "string")))) {
		return Response.json({ error: "body must contain only string versionIds when provided" }, { status: 400 });
	}
	try {
		deletePromptEditorHistory(body.versionIds as string[] | undefined);
		return Response.json({ deleted: true });
	} catch (error) {
		console.error("[prompt history] could not delete", error);
		return Response.json({ error: "Could not delete prompt history" }, { status: 500 });
	}
}

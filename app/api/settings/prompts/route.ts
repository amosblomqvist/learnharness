import { PROMPT_EDITOR_IDS, type PromptEditorId } from "@/src/core";
import { getPromptEditors, savePromptEditor } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return Response.json(getPromptEditors());
	} catch (error) {
		console.error("[prompt editors] could not load", error);
		return Response.json({ error: "Could not load prompt editors" }, { status: 500 });
	}
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null) as { editor?: unknown; text?: unknown } | null;
	if (!body || !PROMPT_EDITOR_IDS.includes(body.editor as PromptEditorId) || typeof body.text !== "string") {
		return Response.json({ error: "body must be {editor: supported editor, text: string}" }, { status: 400 });
	}
	try {
		return Response.json(savePromptEditor(body.editor as PromptEditorId, body.text));
	} catch (error) {
		console.error("[prompt editors] could not save", error);
		return Response.json({ error: "Could not save prompt editor" }, { status: 500 });
	}
}

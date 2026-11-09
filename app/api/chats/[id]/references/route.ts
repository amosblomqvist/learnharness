import { getChat, parseReferencesBody, stores } from "@/src/server";

/**
 * The session reference shelf (issue #63): PUT replace-whole, the
 * per-chat settings route's convention — the panel sends the complete
 * desired list ({} / [] clears the shelf), no merges, so a stale client
 * can never resurrect a removed reference. Validation/admission is
 * src/server/references.ts (parseReferencesBody): file values must pass
 * the existing source-access admission and exist; URL values must be
 * http(s).
 *
 * Like the settings PUT: no updatedAt bump (sidebar order must not churn)
 * and effective at the NEXT turn's agent construction — the running turn,
 * if any, composed its prompt already; that is the same next-turn
 * semantics a model change has, not a race.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	const parsed = parseReferencesBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	stores.chatStore.saveReferences(id, parsed.references);
	return Response.json({ references: parsed.references });
}

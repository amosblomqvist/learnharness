/**
 * THE ANKI DECK EXPORT (issue #11): the session's quiz history as a
 * ready-to-open .apkg — one Basic card per graded quiz-family answer
 * (quiz/probe/explain/recall) and per concluded practice problem with a
 * committed model solution. Deterministic GUIDs mean re-exports UPDATE
 * the deck in Anki instead of duplicating it.
 *
 * GET /api/chats/:id/anki → the .apkg download (Content-Disposition
 * attachment; filename from the slugified title), mirroring the markdown
 * route's shape. 404 unknown chat. A runtime without node:sqlite gets a
 * clear 500 — the builder's guard, surfaced here.
 */
import { AnkiExportUnavailableError, buildAnkiApkg, getChat } from "@/src/server";

/** Filename-safe title (own module scope on purpose: tiny + pure — the
 *  markdown route keeps its identical twin; the routes stay independent). */
function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "session";
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = await buildAnkiApkg({
			chatId: id,
			title: record.title,
			createdAt: record.createdAt,
			messages: record.messages,
		});
	} catch (error) {
		// The feature gate: node:sqlite (Node ≥ 22.5) missing on this host.
		if (error instanceof AnkiExportUnavailableError) {
			return Response.json({ error: error.message }, { status: 500 });
		}
		throw error;
	}
	return new Response(bytes, {
		headers: {
			"content-type": "application/octet-stream",
			"content-disposition": `attachment; filename="${slugify(record.title)}.apkg"`,
		},
	});
}

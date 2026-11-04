/**
 * THE ANKI EXPORT (owner, 2026-11-01): the recall cards the agent wrote
 * during one session, as an Anki TSV import file. Pure, no LLM call: the
 * cards ride the `recall_cards` call arguments, which the transcript
 * already persists — the engine is pinned by tests/anki-export.test.ts.
 *
 * GET /api/chats/:id/anki → TSV attachment (filename from the slugified
 * title, tagged `learnharness` + the session slug). 404 unknown chat;
 * 204 when the session has nothing to export, so the UI can say so.
 */
import { ankiCards, ankiTsv } from "@/src/core";
import { getChat } from "@/src/server";

/** Filename-safe title (own module scope on purpose: tiny + pure). */
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
	const slug = slugify(record.title);
	const cards = ankiCards(record.messages, `learnharness ${slug}`);
	if (cards.length === 0) return new Response(null, { status: 204 });
	return new Response(ankiTsv(cards), {
		headers: {
			"content-type": "text/tab-separated-values; charset=utf-8",
			"content-disposition": `attachment; filename="${slug}-anki.txt"`,
		},
	});
}

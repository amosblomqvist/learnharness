import { getChat, sessionNotesPdf, NotesRequestError } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const bytes = await sessionNotesPdf(id);
		const title = (getChat(id)?.title ?? "Session notes")
			.replace(/[\\/:*?"<>|]/g, "-")
			.replace(/\p{Cc}/gu, "")
			.trim()
			.slice(0, 160)
			.toWellFormed();
		const filename = `${title || "Session notes"}.pdf`;
		const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
		const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
		return new Response(new Uint8Array(bytes), {
			headers: {
				"Content-Type": "application/pdf",
				"Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Could not read PDF." },
			{ status: error instanceof NotesRequestError ? error.status : 500 },
		);
	}
}

import { sessionNotesPdf, NotesRequestError } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return new Response(new Uint8Array(sessionNotesPdf(id)), {
			headers: {
				"Content-Type": "application/pdf",
				"Content-Disposition": `attachment; filename="${id}-notes.pdf"`,
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

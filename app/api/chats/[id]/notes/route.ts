import { sessionNotes, changeSessionNotes, NotesRequestError } from "@/src/server";

type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
	return Response.json(
		{ error: error instanceof Error ? error.message : "Could not load session notes." },
		{ status: error instanceof NotesRequestError ? error.status : 500 },
	);
}
export async function GET(_request: Request, { params }: Context) {
	try {
		return Response.json(sessionNotes((await params).id, true));
	} catch (error) {
		return failure(error);
	}
}
export async function POST(request: Request, { params }: Context) {
	let action: unknown;
	try {
		action = await request.json();
	} catch {
		return Response.json({ error: "Invalid notes action." }, { status: 400 });
	}
	try {
		return Response.json(changeSessionNotes((await params).id, action));
	} catch (error) {
		return failure(error);
	}
}

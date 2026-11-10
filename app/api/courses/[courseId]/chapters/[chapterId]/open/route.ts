import { coursePackSnapshot, CourseImportError, openChapterSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string; chapterId: string }> }) {
	const { courseId, chapterId } = await params;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected a JSON session request." }, { status: 400 });
	}
	const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
	const kind = record.kind === "practice" ? "practice" : record.kind === "teach" ? "teach" : null;
	if (!kind) return Response.json({ error: "Choose teach or practice." }, { status: 400 });
	const conceptId = typeof record.conceptId === "string" ? record.conceptId : undefined;
	try {
		const opened = openChapterSession(courseId, chapterId, kind, conceptId);
		return Response.json(opened);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not open the session.";
		const status = error instanceof CourseImportError ? 400 : 500;
		return Response.json({ error: message, pack: safePack() }, { status });
	}
}

function safePack() {
	try {
		return coursePackSnapshot();
	} catch {
		return null;
	}
}

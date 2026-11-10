import { CourseImportError, gradeCourseItem } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ courseId: string; chapterId: string }> }) {
	const { courseId, chapterId } = await params;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected a JSON review." }, { status: 400 });
	}
	const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
	if (!Number.isInteger(record.grade)) return Response.json({ error: "Grade must be an integer from 0 to 5." }, { status: 400 });
	const conceptId = typeof record.conceptId === "string" ? record.conceptId : undefined;
	try {
		return Response.json({ pack: gradeCourseItem(courseId, chapterId, record.grade as number, conceptId) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not save the review.";
		const status = error instanceof CourseImportError || message.startsWith("Grade must") ? 400 : 500;
		return Response.json({ error: message }, { status });
	}
}

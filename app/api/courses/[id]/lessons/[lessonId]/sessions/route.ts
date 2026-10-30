/**
 * POST /api/courses/:id/lessons/:lessonId/sessions — start a teaching
 * session for the lesson: the chat is created with the course-lesson
 * marker as message[0] and linked to the lesson. Returns the chat id and
 * the opening prompt the client stashes for the auto-sent first message.
 */
import { courseErrorResponse, startLessonSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; lessonId: string }> }) {
	const { id, lessonId } = await params;
	try {
		return Response.json(startLessonSession(id, lessonId));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

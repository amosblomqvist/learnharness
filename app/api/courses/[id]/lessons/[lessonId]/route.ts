/**
 * /api/courses/:id/lessons/:lessonId — edit a lesson (title, goal,
 * guideSummary, targetDate, predictedNodes, prerequisites — cycles
 * refused) or delete it (its sessions stay).
 */
import { courseErrorResponse, courseJsonBody, courseView, deleteLesson, patchLesson } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; lessonId: string }> };

export async function PATCH(req: Request, { params }: Params) {
	const { id, lessonId } = await params;
	try {
		return Response.json(courseView(patchLesson(id, lessonId, await courseJsonBody(req))));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id, lessonId } = await params;
	try {
		return Response.json(courseView(deleteLesson(id, lessonId)));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

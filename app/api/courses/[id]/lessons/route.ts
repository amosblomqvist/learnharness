/** POST /api/courses/:id/lessons — add a lesson by hand. */
import { addLesson, courseErrorResponse, courseJsonBody, courseView } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(courseView(addLesson(id, await courseJsonBody(req))));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

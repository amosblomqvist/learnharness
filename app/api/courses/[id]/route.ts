/**
 * /api/courses/:id — the course page's read (derived statuses, minutes,
 * health, cost), course-level edits (title, goal, deadline, notes; status
 * "active" accepts a draft), and delete (linked sessions stay).
 */
import { courseErrorResponse, courseJsonBody, courseView, deleteCourse, getCourseOr404, patchCourse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(courseView(getCourseOr404(id)));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(courseView(patchCourse(id, await courseJsonBody(req))));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		deleteCourse(id);
		return Response.json({ ok: true });
	} catch (err) {
		return courseErrorResponse(err);
	}
}

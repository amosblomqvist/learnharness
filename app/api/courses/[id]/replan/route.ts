/**
 * /api/courses/:id/replan — POST runs the planner over the not-done
 * lessons into a pending PROPOSAL ({ feedback } absent → dates and
 * estimates only; present → may restructure); DELETE discards it.
 */
import { courseErrorResponse, courseJsonBody, courseView, discardReplan, replanCourse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const body = await courseJsonBody(req);
		const feedback = typeof body.feedback === "string" ? body.feedback : "";
		return Response.json(courseView(await replanCourse(id, feedback, req.signal)));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(courseView(discardReplan(id)));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

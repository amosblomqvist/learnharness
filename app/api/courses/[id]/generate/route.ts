/** POST /api/courses/:id/generate — regenerate a DRAFT with optional { feedback }. */
import { courseErrorResponse, courseJsonBody, courseView, regenerateDraft } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const body = await courseJsonBody(req);
		const feedback = typeof body.feedback === "string" ? body.feedback : "";
		return Response.json(courseView(await regenerateDraft(id, feedback, req.signal)));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

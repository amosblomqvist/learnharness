/** POST /api/courses/:id/replan/accept — apply the pending proposal. */
import { acceptReplan, courseErrorResponse, courseView } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(courseView(acceptReplan(id)));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

/**
 * /api/courses — the course list (sidebar) and Generate (a new DRAFT).
 * Thin transport over src/server/courses.ts. POST takes multipart (field
 * "file" — an uploaded guide) or JSON ({ guideText }), plus goal,
 * deadline and availabilityNotes; the planner runs inside the request
 * (spinner + cancel client-side — the request's abort signal reaches it).
 */
import {
	courseErrorResponse,
	courseJsonBody,
	courseView,
	createCourseDraft,
	CourseError,
	GUIDE_EXTENSIONS,
	listCourseItems,
	type NewCourseInput,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ courses: listCourseItems() });
}

const field = (value: unknown) => (typeof value === "string" ? value : "");

async function readInput(req: Request): Promise<NewCourseInput> {
	if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
		const form = await req.formData();
		const file = form.get("file");
		let guideText = field(form.get("guideText"));
		let fileName: string | undefined;
		if (file instanceof File && file.size > 0) {
			const lower = file.name.toLowerCase();
			if (!GUIDE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
				throw new CourseError(`The guide must be a ${GUIDE_EXTENSIONS.join(", ")} file.`, 400);
			}
			guideText = await file.text();
			fileName = file.name;
		}
		return {
			guideText,
			...(fileName ? { fileName } : {}),
			goalInput: field(form.get("goal")),
			deadline: field(form.get("deadline")),
			availabilityNotes: field(form.get("availabilityNotes")),
		};
	}
	const body = await courseJsonBody(req);
	return {
		guideText: field(body.guideText),
		goalInput: field(body.goal),
		deadline: field(body.deadline),
		availabilityNotes: field(body.availabilityNotes),
	};
}

export async function POST(req: Request) {
	try {
		const record = await createCourseDraft(await readInput(req), req.signal);
		return Response.json(courseView(record));
	} catch (err) {
		return courseErrorResponse(err);
	}
}

import { coursePackSnapshot, importCourse, CourseImportError } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	try {
		return Response.json(coursePackSnapshot());
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not read courses.";
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Expected a JSON import request." }, { status: 400 });
	}
	if (typeof body !== "object" || body === null) return Response.json({ error: "Expected a JSON import request." }, { status: 400 });
	const record = body as Record<string, unknown>;
	try {
		const outcome = await importCourse({
			presetId: typeof record.presetId === "string" ? record.presetId : undefined,
			localPath: typeof record.localPath === "string" ? record.localPath : undefined,
			download: record.download === true,
			courseId: typeof record.courseId === "string" ? record.courseId : undefined,
			extractGraph: record.extractGraph === true,
		});
		return Response.json(outcome);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Import failed.";
		const status = error instanceof CourseImportError ? 400 : 500;
		return Response.json({ error: message }, { status });
	}
}

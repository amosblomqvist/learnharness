import { analysisProgress, readMistakes } from "@/src/server";

export const dynamic = "force-dynamic";

/** Every recorded mistake (newest first) plus the analysis queue's progress. */
export async function GET() {
	const mistakes = readMistakes().sort((a, b) => b.answeredAt.localeCompare(a.answeredAt));
	return Response.json({ mistakes, progress: analysisProgress() });
}

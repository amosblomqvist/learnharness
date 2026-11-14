import { readMistakes } from "@/src/server";

export const dynamic = "force-dynamic";

/** One session's recorded mistakes — the answer cards read the short "why"
 *  from here (keyed by the answer's tool call: `<chatId>:<toolCallId>`). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json({ mistakes: readMistakes().filter((r) => r.chatId === id) });
}

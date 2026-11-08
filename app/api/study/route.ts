/**
 * /api/study — study-time capture and history (design:
 * docs/designs/study-time.md). Thin transport over src/server/study.ts.
 *
 *   POST { input: { type: "active" | "stop", chatId, windowId } | { type: "closeAll" } }
 *     → 200 { ok: true } | 400 invalid_body | 400 chat_not_started | 404 chat_not_found
 *   GET ?tz=<IANA zone>&range=week|month|last7|last30|all
 *     → 200 StudySummary (no-store) | 400 invalid_tz | 400 invalid_range
 *
 * GET also writes: it closes stale timers first.
 */
import { isValidTimeZone, parseStudyInput, STUDY_RANGE_KEYS, StudyInputError, type StudyRangeKey } from "@/src/core";
import { recordStudy, studyHistory } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "invalid_body" }, { status: 400 });
	}
	let input;
	try {
		input = parseStudyInput((body as { input?: unknown } | null)?.input);
	} catch (err) {
		if (err instanceof StudyInputError) return Response.json({ error: "invalid_body" }, { status: 400 });
		throw err;
	}
	const result = recordStudy(input);
	if (result.ok) return Response.json({ ok: true });
	return Response.json({ error: result.error }, { status: result.status });
}

export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const tz = params.get("tz");
	if (!tz || !isValidTimeZone(tz)) return Response.json({ error: "invalid_tz" }, { status: 400 });
	const range = params.get("range");
	if (!range || !(STUDY_RANGE_KEYS as readonly string[]).includes(range)) {
		return Response.json({ error: "invalid_range" }, { status: 400 });
	}
	return Response.json(studyHistory(tz, range as StudyRangeKey), { headers: { "Cache-Control": "no-store" } });
}

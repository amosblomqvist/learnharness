/**
 * GET /api/settings/prompts — the system-prompt segment view
 * (settings-storage wave, 2026-09-19): the effective prompt segments for
 * Teacher, Prober and Practice, derived from SOURCE at runtime (src/agent/prompts — the
 * list adapts when the code ships/renames/removes fragments), each with
 * its source text, override text (if a file exists), and effective switch
 * state (settings record's agent.prompts map AND file presence).
 *
 *   GET → 200 {prober: SegmentInfo[], teacher: SegmentInfo[], practice: SegmentInfo[]}
 *   SegmentInfo = {path, sourceText, overrideText, enabled, shared}
 *
 * Shared usage is discoverable by path membership in these lists. The
 * shared base appears in Teacher and Prober, NOT Practice; Practice has
 * its own base and a subset of shared fragments. Writes: the switches go
 * through PUT /api/settings/agent; the TEXT goes through
 * PUT/DELETE /api/settings/prompts/[...segment].
 */

import { effectivePromptSegments, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const switches = readSettingsRecord()?.agent?.prompts ?? {};
	return Response.json({
		prober: effectivePromptSegments("prober", switches),
		teacher: effectivePromptSegments("teacher", switches),
		practice: effectivePromptSegments("practice", switches),
		notes: effectivePromptSegments("notes", switches),
	});
}

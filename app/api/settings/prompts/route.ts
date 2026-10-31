import { withUser } from "@/src/server/auth/context.ts";
/**
 * GET /api/settings/prompts — the system-prompt segment view
 * (settings-storage wave, 2026-09-19): the effective prompt segments for
 * BOTH agents, derived from SOURCE at runtime (src/agent/prompts — the
 * list adapts when the code ships/renames/removes fragments), each with
 * its source text, override text (if a file exists), and effective switch
 * state (settings record's agent.prompts map AND file presence).
 *
 *   GET → 200 {prober: SegmentInfo[], teacher: SegmentInfo[]}
 *   SegmentInfo = {path, sourceText, overrideText, enabled, shared}
 *
 * The shared base appears in BOTH lists under the SAME path
 * ("system-prompt.md") — the prompt-editor's "what's constant between the
 * two agents" is discoverable by path equality. Writes: the switches go
 * through PUT /api/settings/agent; the TEXT goes through
 * PUT/DELETE /api/settings/prompts/[...segment].
 */

import { effectivePromptSegments, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = withUser(async function GET() {
	const switches = readSettingsRecord()?.agent?.prompts ?? {};
	return Response.json({
		prober: effectivePromptSegments("prober", switches),
		teacher: effectivePromptSegments("teacher", switches),
	});
});

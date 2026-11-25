/**
 * PUT/DELETE /api/settings/prompts/[...segment] — the override TEXT for
 * one prompt segment (settings-storage wave, 2026-09-19).
 *
 *   PUT    body {text} → writes data/prompts/<segment path mirror>. 200.
 *          The segment must be a CURRENT source segment (allSegmentPaths
 *          — derived from src/agent/prompts at runtime): overriding a
 *          segment that doesn't compose is a typo or a vanished fragment,
 *          a 400, never a silent orphan.
 *   DELETE → removes the override file (idempotent) AND clears the
 *          record's switch for that segment in the same operation
 *          (contract fix, interlude 2026-09-26 — overrules the 2026-09-19
 *          "switch survives a delete/re-write cycle" note). The old
 *          behavior orphaned the on-switch: the write validation then
 *          400'd every agent-section write while the UI's disabled toggle
 *          couldn't reach the OFF escape hatch — a user stuck unable to
 *          write settings. Delete clears the switch so the route and the
 *          record agree BY CONSTRUCTION; the write path additionally heals
 *          any orphan that still arises (disk-level wipes outside the
 *          app's control) — see [section]/route.ts. Order here: clear the
 *          switch first, then unlink — a crash between the two leaves
 *          "off + file", a valid state, never an orphan.
 *
 * The ON/OFF switch itself lives in the record's agent.prompts map
 * (PUT /api/settings/agent) — file presence alone is never the override.
 */

import {
	allSegmentPaths,
	isValidSegmentPath,
	promptOverrides,
	readSettingsRecord,
	writeSettingsRecord,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** Re-join the catch-all segments into the mirror-layout path; null when
 *  the shape is invalid (traversal, wrong layout — the store re-guards). */
function segmentPathFrom(segments: string[]): string | null {
	const joined = segments.map(decodeURIComponent).join("/");
	return isValidSegmentPath(joined) ? joined : null;
}

export async function PUT(request: Request, ctx: { params: Promise<{ segment: string[] }> }) {
	const { segment } = await ctx.params;
	const path = segmentPathFrom(segment);
	if (!path) return Response.json({ error: "invalid segment path" }, { status: 400 });
	const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
	if (!body || typeof body.text !== "string") {
		return Response.json({ error: "body must be {text: string}" }, { status: 400 });
	}
	if (!new Set(allSegmentPaths()).has(path)) {
		return Response.json(
			{ error: `"${path}" is not a current source segment`, supported: allSegmentPaths() },
			{ status: 400 },
		);
	}
	promptOverrides.writeOverride(path, body.text);
	return Response.json({ path, text: body.text });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ segment: string[] }> }) {
	const { segment } = await ctx.params;
	const path = segmentPathFrom(segment);
	if (!path) return Response.json({ error: "invalid segment path" }, { status: 400 });
	// Clear the record's switch FIRST (crash between the two leaves "off +
	// file" — valid — never an orphaned ON), then unlink the file.
	const record = readSettingsRecord();
	const hadSwitch = record?.agent?.prompts?.[path] === true;
	if (record && record.agent?.prompts?.[path] !== undefined) {
		const prompts = { ...record.agent.prompts };
		delete prompts[path];
		writeSettingsRecord({ ...record, agent: { ...record.agent, prompts } });
	}
	promptOverrides.deleteOverride(path);
	// switchCleared tells the caller their on-switch went off WITH the file
	// (additive; the GET view derives the same truth from record+file).
	return Response.json({ path, deleted: true, switchCleared: hadSwitch });
}

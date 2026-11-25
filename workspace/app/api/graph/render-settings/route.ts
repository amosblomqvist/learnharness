/**
 * GET/PUT /api/graph/render-settings — server persistence for the graph
 * view's rendering controls (node/edge/arrow/label sizes, the label-zoom
 * threshold, the cluster-labels toggle). The file lives at
 * data/render-settings.json (config.RENDER_SETTINGS_FILE).
 *
 *   GET → 200 {settings} once saved, 200 null on first boot (client keeps
 *         in-memory defaults until the user changes something).
 *   PUT → 200 {settings} (the sanitized copy actually persisted — the
 *         client may echo it to stay honest with clamped values).
 *
 * Every body is passed through sanitizeRenderSettings (src/core) before
 * touching disk: garbage clamps or falls back to defaults, never throws.
 */
import { readRenderSettings, writeRenderSettings } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(readRenderSettings());
}

export async function PUT(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	return Response.json(writeRenderSettings(body));
}

/**
 * DELETE /api/themes/[id] (theme wave, 2026-11-04) — remove an imported
 * theme. Presets cannot be removed (400); an unknown id is a 404. When
 * the removed theme was active, the record falls back to "default" and
 * every color override stays exactly as it was.
 */

import { isBuiltinThemeId } from "@/src/core";
import { readSettingsRecord, themeStore, writeSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	if (isBuiltinThemeId(id)) return Response.json({ error: `"${id}" is a built-in theme` }, { status: 400 });
	const theme = themeStore.readTheme(id);
	if (!theme) return Response.json({ error: `unknown theme "${id}"` }, { status: 404 });
	themeStore.deleteTheme(id);
	const record = readSettingsRecord();
	if (record?.appearance?.theme === id) {
		writeSettingsRecord({ ...record, appearance: { ...record.appearance, theme: "default" } });
	}
	return Response.json({ theme });
}

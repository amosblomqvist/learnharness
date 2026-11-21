/**
 * /api/themes (theme wave, 2026-11-04) — the theme catalog.
 *
 *   GET  → 200 { themes: Theme[] }: the built-in presets, then the
 *          imported customs (config.THEMES_DIR) sorted by id.
 *   POST → body = a ThemeFile { name, mode, colors: {…12 hex} }. Invalid
 *          → 400 naming the first bad field, nothing written. Valid → the
 *          id is the name's slug (builtin ids reserved, collisions get
 *          -2, -3, …), the file lands at <id>.json → 201 { theme }.
 */

import { BUILTIN_THEMES, isBuiltinThemeId, isThemeId, parseThemeFile, themeIdFromName } from "@/src/core";
import { themeStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ themes: [...BUILTIN_THEMES, ...themeStore.listThemes()] });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => undefined);
	if (body === undefined) return Response.json({ error: "body must be JSON" }, { status: 400 });
	const parsed = parseThemeFile(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const base = themeIdFromName(parsed.theme.name);
	const taken = (id: string) => isBuiltinThemeId(id) || themeStore.readTheme(id) !== null;
	let id = base;
	for (let n = 2; taken(id); n++) {
		const suffix = `-${n}`;
		id = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
	}
	if (!isThemeId(id)) return Response.json({ error: "name must produce a valid theme id" }, { status: 400 });
	themeStore.writeTheme(id, parsed.theme);
	return Response.json({ theme: { ...parsed.theme, id, builtin: false } }, { status: 201 });
}

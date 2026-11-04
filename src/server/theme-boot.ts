/**
 * THE FIRST-PAINT THEME (theme wave, 2026-11-04): what app/layout.tsx puts
 * on <html> before any client code runs — the record's appearance, the
 * active theme (a preset or an imported file; Default when the id is gone)
 * and its color variables with every override applied. One disk read of
 * the record and the theme dir per request (the layout calls connection()
 * first, so this never bakes into a prerender).
 */

import { effectiveColors, resolveTheme, themeVars, type AppearanceSettings, type Theme } from "../core";
import { themeStore } from "../store/themes.ts";
import { readSettings } from "../store/settings.ts";

/** Everything the layout needs for a flash-free first paint. */
export interface ThemeBoot {
	appearance: AppearanceSettings | undefined;
	theme: Theme;
	/** The CSS variables for <html style>. */
	vars: Record<string, string>;
}

/** Read the record and the theme dir; resolve the active theme and its vars. */
export function readThemeBoot(): ThemeBoot {
	const appearance = readSettings()?.appearance;
	const theme = resolveTheme(appearance?.theme, themeStore.listThemes());
	return { appearance, theme, vars: themeVars(effectiveColors(theme, appearance), theme.mode) };
}

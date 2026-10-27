/**
 * THE SYSTEM THEME FILE (Omarchy theme, 2026-10-26): a desktop theme
 * published as a complete LearnHarness palette — one JSON file the desktop
 * rewrites on every theme switch, the same way Omarchy publishes
 * ~/.t3/userdata/themes/omarchy.json for T3 Code.
 *
 *   { "name": "Omarchy", "mode": "dark" | "light",
 *     "colors": { "background": "#…", "foreground": "#…", … } }
 *
 * Every palette token is required: a partial file would mix the desktop's
 * colors with the factory dark palette (unreadable under a light theme), so
 * an incomplete or malformed file reads as NO theme and the app keeps its
 * own look. Pure — the server reads the bytes, the shell applies the vars.
 */

import { isHexColor } from "./settings.ts";

/** The palette tokens, in globals.css order: file key → CSS variable. */
export const SYSTEM_THEME_COLOR_VARS = {
	background: "--background",
	foreground: "--foreground",
	card: "--card",
	cardForeground: "--card-foreground",
	popover: "--popover",
	popoverForeground: "--popover-foreground",
	primary: "--primary",
	primaryForeground: "--primary-foreground",
	secondary: "--secondary",
	secondaryForeground: "--secondary-foreground",
	muted: "--muted",
	mutedForeground: "--muted-foreground",
	accent: "--accent",
	accentForeground: "--accent-foreground",
	destructive: "--destructive",
	border: "--border",
	input: "--input",
	ring: "--ring",
} as const;

export type SystemThemeColor = keyof typeof SYSTEM_THEME_COLOR_VARS;

export interface SystemTheme {
	name: string;
	mode: "dark" | "light";
	colors: Record<SystemThemeColor, string>;
}

/** The file's contents → a complete theme, or null (absent/partial/bad). */
export function sanitizeSystemTheme(raw: unknown): SystemTheme | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (r.mode !== "dark" && r.mode !== "light") return null;
	if (r.colors === null || typeof r.colors !== "object" || Array.isArray(r.colors)) return null;
	const rawColors = r.colors as Record<string, unknown>;
	const colors = {} as Record<SystemThemeColor, string>;
	for (const key of Object.keys(SYSTEM_THEME_COLOR_VARS) as SystemThemeColor[]) {
		const value = rawColors[key];
		if (typeof value !== "string" || !isHexColor(value)) return null;
		colors[key] = value;
	}
	const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : "System";
	return { name, mode: r.mode, colors };
}

/** The CSS variables a theme sets on <html>, color-scheme included so
 *  native controls and scrollbars follow a light theme. */
export function systemThemeVars(theme: SystemTheme): Record<string, string> {
	const vars: Record<string, string> = { "color-scheme": theme.mode };
	for (const [key, cssVar] of Object.entries(SYSTEM_THEME_COLOR_VARS)) {
		vars[cssVar] = theme.colors[key as SystemThemeColor];
	}
	return vars;
}

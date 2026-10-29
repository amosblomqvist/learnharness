/**
 * APPEARANCE MODE + PALETTES (light-mode wave, 2026-10-29): which variant
 * renders, and the per-variant derivation curves over a background hex.
 * Pure, browser-safe — the provider, the Settings preview cards and the
 * tests share it.
 */

export type AppearanceMode = "dark" | "light" | "system";
export type RenderedMode = "dark" | "light";

export function resolveRenderedMode(mode: AppearanceMode, prefersDark: boolean): RenderedMode {
	if (mode === "system") return prefersDark ? "dark" : "light";
	return mode;
}

/** First paint under System (Next's preventing-flash guide): the server
 *  renders data-lh-mode from the settings record but cannot know the OS,
 *  so this runs synchronously in <head>, before any paint, and swaps the
 *  class when the OS disagrees with the server's dark default. */
export const SYSTEM_MODE_SCRIPT =
	'(function(){try{var d=document.documentElement;if(d.dataset.lhMode!=="system")return;' +
	'var k=matchMedia("(prefers-color-scheme: dark)").matches;' +
	'd.classList.toggle("dark",k);d.classList.toggle("light",!k)}catch(e){}})()';

export const MODE_DEFAULT_BACKGROUND: Record<RenderedMode, string> = { dark: "#141414", light: "#f5f5f3" };

/** Shift every channel by `add`, clamped to 0–255. */
function shift(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.min(255, Math.max(0, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** The fixed inks per variant (only the surfaces derive from the background). */
const INKS: Record<RenderedMode, { fg: string; mutedFg: string; destructive: string; lineStrong: string }> = {
	dark: { fg: "#e6e6e6", mutedFg: "#8d8d8d", destructive: "oklch(0.704 0.191 22.216)", lineStrong: "#ffffff" },
	light: { fg: "#1a1a1a", mutedFg: "#6b6b68", destructive: "oklch(0.577 0.245 27.325)", lineStrong: "#1a1a1a" },
};

/** The full token map one variant implies for a background (null = the
 *  variant's default). Dark: raised surfaces LIGHTER (+8 / +22 / +47 —
 *  today's hand-picked offsets). Light ("paper"): raised surfaces are
 *  white, edges darker (−13 / −33). app/globals.css carries the defaults
 *  as literals (pinned equal by tests/appearance-palette.test.ts). */
export function variantPalette(mode: RenderedMode, background: string | null): Record<string, string> {
	const bg = background ?? MODE_DEFAULT_BACKGROUND[mode];
	const ink = INKS[mode];
	const raised = mode === "dark" ? shift(bg, 8) : "#ffffff";
	const accent = mode === "dark" ? shift(bg, 22) : shift(bg, -13);
	const edge = mode === "dark" ? shift(bg, 47) : shift(bg, -33);
	return {
		"--background": bg,
		"--foreground": ink.fg,
		"--card": raised,
		"--card-foreground": ink.fg,
		"--popover": raised,
		"--popover-foreground": ink.fg,
		"--primary": ink.fg,
		"--primary-foreground": bg,
		"--secondary": raised,
		"--secondary-foreground": ink.fg,
		"--muted": raised,
		"--muted-foreground": ink.mutedFg,
		"--accent": accent,
		"--accent-foreground": ink.fg,
		"--destructive": ink.destructive,
		"--border": edge,
		"--input": edge,
		"--ring": ink.mutedFg,
		"--lh-line-strong": ink.lineStrong,
	};
}

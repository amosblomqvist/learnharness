/**
 * THEMED DEMOS: the learner's theme, handed to a demo as CSS variables.
 *
 * A demo runs in a sandboxed iframe (opaque origin), so the app's own
 * variables never reach it. A demo that opts in with
 * `<meta name="lh-theme" content="app">` gets a `<style data-lh-theme>`
 * injected at the top of its <head>: the theme as `--lh-*` variables on
 * :root, a transparent page (the card shows through), the theme's text
 * color and a system font. The frame's bridge swaps that style's text when
 * the theme changes and fires `lh-theme-change`, so canvas demos redraw
 * without a reload. Documents without the meta tag render exactly as
 * before.
 *
 * Pure and browser-safe: the demo card and the demo builder's headless
 * run share it.
 */

import { shiftHex, type ThemeColors, type ThemeMode } from "./themes.ts";

/** The opt-in marker a themed demo puts in its <head>. */
export const ARTIFACT_THEME_META = '<meta name="lh-theme" content="app">';

/** Whether a demo document opted into the app theme. */
export function isThemedDemo(html: string): boolean {
	return /<meta\b[^>]*\bname\s*=\s*["']?lh-theme["']?[^>]*>/i.test(html);
}

const FONT_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** Series colors for themes whose own inks are too few or too gray (the
 *  Default theme is all grays). Tailwind 400s on dark, 600s on light;
 *  more than six, because some get skipped for sitting too close to a
 *  theme's success/warning/error colors. */
const FALLBACK_SERIES: Record<ThemeMode, readonly string[]> = {
	dark: ["#60a5fa", "#c084fc", "#2dd4bf", "#f472b6", "#fb923c", "#a3e635", "#818cf8", "#facc15", "#38bdf8", "#e879f9"],
	light: ["#2563eb", "#9333ea", "#0d9488", "#db2777", "#ea580c", "#65a30d", "#4f46e5", "#ca8a04", "#0284c7", "#c026d3"],
};

const SERIES_COUNT = 6;

function rgb(hex: string): [number, number, number] {
	const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** HSL saturation, 0–1. */
function saturation(hex: string): number {
	const [r, g, b] = rgb(hex).map((c) => c / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return 0;
	return (max - min) / (1 - Math.abs(2 * l - 1));
}

function luminance(hex: string): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const [r, g, b] = rgb(hex);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

function distance(a: string, b: string): number {
	const [r1, g1, b1] = rgb(a);
	const [r2, g2, b2] = rgb(b);
	return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

/** Six distinct series colors: the theme's own colored inks first (accent,
 *  bold, italic, code), then the fallback set. A color is skipped when it
 *  is gray, hard to see on the card, or too close to one already picked
 *  or to success/warning/error (a demo uses those for state, and a series
 *  that looks like "error" would read as one). */
export function seriesColors(c: ThemeColors, mode: ThemeMode): string[] {
	const picked: string[] = [];
	const semantic = [c.success, c.warning, c.error];
	const consider = (hex: string) => {
		if (picked.length >= SERIES_COUNT) return;
		if (saturation(hex) < 0.25) return;
		if (contrast(hex, c.surface) < 2) return;
		if ([...picked, ...semantic].some((p) => distance(p, hex) < 60)) return;
		picked.push(hex.toLowerCase());
	};
	for (const hex of [c.accent, c.bold, c.italic, c.code]) consider(hex);
	for (const hex of FALLBACK_SERIES[mode]) consider(hex);
	// A theme can crowd out the fallbacks; fill with them regardless.
	for (const hex of FALLBACK_SERIES[mode]) if (picked.length < SERIES_COUNT && !picked.includes(hex)) picked.push(hex);
	return picked;
}

/** THE adapter: theme colors → the `--lh-*` variables a demo reads. */
export function artifactThemeVars(c: ThemeColors, mode: ThemeMode): Record<string, string> {
	const vars: Record<string, string> = {
		"--lh-text": c.text,
		"--lh-muted": c.textMuted,
		"--lh-border": c.border,
		"--lh-surface": c.surface,
		"--lh-raised": shiftHex(c.surface, mode === "dark" ? 12 : -12),
		"--lh-accent": c.accent,
		"--lh-success": c.success,
		"--lh-error": c.error,
		"--lh-warning": c.warning,
		"--lh-font": FONT_SANS,
		"--lh-mono": FONT_MONO,
		"--lh-radius": "8px",
	};
	seriesColors(c, mode).forEach((hex, i) => {
		vars[`--lh-chart-${i + 1}`] = hex;
	});
	return vars;
}

/** The injected sheet's text. Base rules sit in :where() (zero
 *  specificity), so any rule the demo writes wins over them. */
export function artifactThemeCss(c: ThemeColors, mode: ThemeMode): string {
	const decls = Object.entries(artifactThemeVars(c, mode))
		.map(([k, v]) => `${k}:${v};`)
		.join("");
	return (
		`:root{${decls}color-scheme:${mode};accent-color:var(--lh-accent);}` +
		":where(html,body){background:transparent;color:var(--lh-text);font-family:var(--lh-font);}"
	);
}

/** Insert the theme sheet at the top of <head> (else after <html>, else
 *  first), so the demo's own styles come later and win ties. */
export function injectArtifactTheme(html: string, css: string): string {
	const tag = `<style data-lh-theme>${css.replace(/</g, "\\3c ")}</style>`;
	const head = /<head\b[^>]*>/i.exec(html);
	if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
	// No <head>: after <html>, else after the doctype (a tag before the
	// doctype would drop the page into quirks mode), else first.
	const anchor = /<html\b[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
	if (anchor) return html.slice(0, anchor.index + anchor[0].length) + tag + html.slice(anchor.index + anchor[0].length);
	return tag + html;
}

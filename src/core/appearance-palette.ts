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

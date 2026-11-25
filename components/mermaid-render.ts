/**
 * The app's ONE chat-diagram renderer: renders `mermaid` fences synchronously
 * into SVG via `pele` for both the inline block (components/md-blocks.tsx) and
 * the session-scoped focus overlay (components/session-overlay.tsx).
 *
 * Usage: `renderMermaid(chart)` returns `{ svg, error: null }` or
 * `{ svg: null, error }`. Colors and fonts bind to `--pele-*` CSS custom
 * properties (app/globals.css), so theme changes apply without re-rendering.
 *
 * Limits: remote images and links are disabled (`images: false`, `links: false`);
 * upstream `%%{init}%%` theme directives are ignored in favor of house tokens.
 */

import { render } from "pele";

/** The chart's base font size (px) — pele sizes text relative to this, so
 *  the display-width cap (md-blocks.tsx) divides by it to keep chart text at
 *  or below the session's reading size. */
export const MERMAID_FONT_SIZE = 16;

/** Fixed render options pinned by the host: uses the active reading font
 *  (`--font-prose`) at the prose baseline size and disables external images
 *  and clickable links inside diagrams. */
export const PELE_RENDER_OPTIONS = {
	fontFamily: "sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	images: false,
	links: false,
} as const;

export type DiagramRenderResult = { svg: string; error: null } | { svg: null; error: string };

/** Resolve the computed CSS prose font stack in the browser so Pele measures
 *  the same font CSS draws (`var(--font-prose)`), preventing box overflow on
 *  non-default or monospace reading fonts. Returns undefined during SSR. */
export function resolvedChartFont(el?: Element | null): string | undefined {
	if (typeof document === "undefined" || typeof getComputedStyle !== "function") return undefined;
	const target = el ?? document.querySelector(".lh-prose");
	if (target) return getComputedStyle(target).fontFamily || undefined;
	const probe = document.createElement("span");
	probe.className = "lh-prose";
	probe.style.display = "none";
	document.body?.appendChild(probe);
	const family = getComputedStyle(probe).fontFamily || undefined;
	probe.remove();
	return family;
}

/** Synchronously render one Mermaid-syntax chart source to an SVG string. */
export function renderMermaid(chart: string, fontFamily?: string): DiagramRenderResult {
	try {
		const options = fontFamily ? { ...PELE_RENDER_OPTIONS, fontFamily } : PELE_RENDER_OPTIONS;
		const { svg } = render(chart, options);
		return { svg, error: null };
	} catch (error) {
		return { svg: null, error: error instanceof Error ? error.message : String(error) };
	}
}

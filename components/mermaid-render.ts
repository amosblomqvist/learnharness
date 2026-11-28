/**
 * The app's ONE chat-diagram renderer: renders `mermaid` fences synchronously
 * into SVG via `pele` for both the inline block (components/md-blocks.tsx) and
 * the session-scoped focus overlay (components/session-overlay.tsx).
 *
 * Usage: `renderMermaid(chart, fontFamily?, idPrefix?)` returns
 * `{ svg, error: null }` or `{ svg: null, error }`. Colors and fonts bind to
 * `--pele-*` CSS custom properties (app/globals.css), so theme changes apply
 * without re-rendering. TeX math in `$$...$$` labels compiles synchronously to
 * MathML Core via `temml` (the only file that imports it; styled under
 * `.pele-math` in app/globals.css).
 *
 * Limits:
 * - Remote images, diagram links, and untrusted TeX commands (`\includegraphics`,
 *   `\style`, `\class`, `\id`, `\data`) are disabled (`images: false`,
 *   `links: false`, `trust: false`); upstream `%%{init}%%` theme directives
 *   are ignored in favor of house tokens.
 * - TeX math compiles with `displayMode: false` (inline-compact; display-only
 *   AMS environments, `\tag`, and `\label` stay disabled) and `maxSize: [25, 300]`
 *   (caps `\rule` dimensions). Pele matches `/\$\$(.+?)\$\$/g`, so paired `$$`
 *   in plain labels (e.g. currency) is treated as TeX.
 * - TeX math renders inside SVG `<foreignObject>` using OS OpenType MATH fonts
 *   (not portable to standalone SVG rasterizers such as resvg).
 * - SSR and the initial pre-mount pass (`fontFamily === undefined`) use a fixed
 *   pure text measurer and structural MathML estimator so server HTML and first
 *   client hydration match byte-for-byte; post-mount calls measure with browser
 *   Canvas and a temporary hidden DOM probe removed in `finally` (zero global
 *   mutable state).
 * - Invalid or untrusted TeX falls back cleanly to literal `$$...$$` text.
 */

import { render, type MathMarkup, type TextMeasurer } from "pele";
import temml from "temml";

/** The chart's base font size (px) — pele sizes text relative to this, so
 *  the em display-width cap (md-blocks.tsx) divides by it to match the
 *  session's reading size at any scale. */
export const MERMAID_FONT_SIZE = 16;

/** Fixed render options pinned by the host: falls back to `sans-serif` before
 *  mount (callers pass the live prose stack after mount), uses the 16px prose
 *  baseline size, and disables external images and clickable diagram links. */
export const PELE_RENDER_OPTIONS = {
	fontFamily: "sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	images: false,
	links: false,
} as const;

const TEMML_OPTIONS = {
	displayMode: false,
	xml: true,
	wrap: "none",
	trust: false,
	throwOnError: true,
	maxSize: [25, 300] as [number, number],
} as const;

/** Fixed pure measurer used when `fontFamily` is undefined (SSR and initial
 *  client render before mount) so Node and browser emit identical SVG bytes. */
const SSR_MEASURER: TextMeasurer = {
	width: (text: string, size: number) => Array.from(text).length * size * 0.55,
};

export type DiagramRenderResult = { svg: string; error: null } | { svg: null; error: string };

function estimateMathSize(mathml: string, size: number): { width: number; height: number } {
	const visible = Array.from(mathml.replace(/<[^>]+>/g, "").trim()).length;
	const rows = (mathml.match(/<mtr\b/g) ?? []).length;
	const cells = (mathml.match(/<mtd\b/g) ?? []).length;
	const fracs = (mathml.match(/<mfrac\b/g) ?? []).length;
	const hasScripts = /<(?:msup|msub|msubsup|mover|munder|munderover|msqrt|mroot)\b/.test(mathml);

	let width: number;
	if (rows > 1) {
		const cols = Math.max(1, Math.ceil(cells / rows));
		const perRow = Math.max(cols, visible / rows);
		width = Math.ceil(perRow * size * 0.62 + cols * size * 0.45) + 8;
	} else {
		const effectiveChars = Math.max(1, visible - fracs * 0.6);
		width = Math.ceil(Math.max(size * 0.8, effectiveChars * size * 0.62)) + 4;
	}

	let height: number;
	if (rows > 1) height = Math.ceil(rows * size * 1.25) + 4;
	else if (fracs > 0) height = Math.ceil(size * 1.85) + 4;
	else if (hasScripts) height = Math.ceil(size * 1.35) + 4;
	else height = Math.ceil(size * 1.15) + 4;

	return { width, height };
}

function measureWithProbe(probe: HTMLDivElement, mathml: string, size: number): { width: number; height: number } | null {
	try {
		probe.style.fontSize = `${size}px`;
		probe.innerHTML = mathml;
		const rect = (probe.firstElementChild ?? probe).getBoundingClientRect();
		if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
			return null;
		}
		return { width: Math.ceil(rect.width) + 2, height: Math.ceil(rect.height) + 2 };
	} catch {
		return null;
	} finally {
		probe.textContent = "";
	}
}

function sanitizeIdPrefix(prefix?: string): string | undefined {
	if (!prefix) return undefined;
	const clean = prefix.replace(/[^A-Za-z0-9_-]+/g, "_");
	return clean || undefined;
}

/** Resolve the computed CSS prose font stack in the browser so Pele measures
 *  the same font CSS draws (`var(--font-prose)`), preventing box overflow on
 *  non-default or monospace reading fonts. Pass the chart's own container element
 *  so unrelated `.lh-prose` elements elsewhere in the page cannot skew it.
 *  Returns undefined during SSR. */
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
export function renderMermaid(chart: string, fontFamily?: string, idPrefix?: string): DiagramRenderResult {
	let probe: HTMLDivElement | null = null;
	try {
		const canMeasure = Boolean(fontFamily) && typeof document !== "undefined" && Boolean(document.body);
		const math = (tex: string, size: number): MathMarkup | null => {
			let html: string;
			try {
				html = temml.renderToString(tex, TEMML_OPTIONS);
			} catch {
				return null;
			}
			if (!html.includes("<math")) return null;
			if (canMeasure) {
				if (!probe) {
					probe = document.createElement("div");
					probe.className = "pele-math";
					probe.setAttribute("aria-hidden", "true");
					probe.style.cssText =
						"position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;display:inline-block;line-height:normal;white-space:nowrap;";
					document.body.appendChild(probe);
				}
				const measured = measureWithProbe(probe, html, size);
				if (measured) return { html, ...measured };
			}
			return { html, ...estimateMathSize(html, size) };
		};
		const safePrefix = sanitizeIdPrefix(idPrefix);
		const options = fontFamily
			? { ...PELE_RENDER_OPTIONS, fontFamily, math, ...(safePrefix ? { idPrefix: safePrefix } : {}) }
			: { ...PELE_RENDER_OPTIONS, measurer: SSR_MEASURER, math, ...(safePrefix ? { idPrefix: safePrefix } : {}) };
		const { svg } = render(chart, options);
		return { svg, error: null };
	} catch (error) {
		return { svg: null, error: error instanceof Error ? error.message : String(error) };
	} finally {
		(probe as HTMLDivElement | null)?.remove();
	}
}

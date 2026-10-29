/**
 * FIGURE/DEMO AUTO-INVERT (2026-10-29): agent artifacts are drawn on a
 * light background (visual-maker + demo-builder prompts), so in the dark
 * app they read as white boxes. The invert switch's persisted value
 * (details.ui.inverted) becomes a PIN:
 *
 *   - no pin = auto: inverted while the app renders dark AND the artifact
 *     measured light ("unknown" never auto-flips — a dark figure must not
 *     be turned light by accident);
 *   - a pin is absolute and wins in every mode;
 *   - toggling to the value auto would show CLEARS the pin, so "flip and
 *     flip back" returns the figure to following the mode.
 *
 * Pure, browser-safe (the cards and the artifact-ui route share it).
 */

/** Whether an artifact was drawn light — measured in the browser. */
export type ArtifactTone = "light" | "dark" | "unknown";

/** The palette the app is rendering right now. */
export type RenderedMode = "dark" | "light";

export function autoInverted(mode: RenderedMode, tone: ArtifactTone): boolean {
	return mode === "dark" && tone === "light";
}

export function effectiveInverted(pin: boolean | undefined, mode: RenderedMode, tone: ArtifactTone): boolean {
	return pin ?? autoInverted(mode, tone);
}

/** The pin a toggle to `next` stores: null (clear) when it equals auto. */
export function nextInvertPin(next: boolean, mode: RenderedMode, tone: ArtifactTone): boolean | null {
	return next === autoInverted(mode, tone) ? null : next;
}

/** WCAG relative luminance of an sRGB color (channels 0–255) → 0–1. */
export function relativeLuminance(r: number, g: number, b: number): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The background tone of an RGBA raster: the MEDIAN luminance of its
 *  perimeter pixels (the page around the content), ≥ 0.5 = light. The
 *  caller composites over white first — the cards' holders are white. */
export function toneFromPixels(data: Uint8ClampedArray | Uint8Array, width: number, height: number): ArtifactTone {
	if (width <= 0 || height <= 0 || data.length < width * height * 4) return "unknown";
	const lum: number[] = [];
	const at = (x: number, y: number) => {
		const i = (y * width + x) * 4;
		lum.push(relativeLuminance(data[i]!, data[i + 1]!, data[i + 2]!));
	};
	for (let x = 0; x < width; x++) {
		at(x, 0);
		at(x, height - 1);
	}
	for (let y = 1; y < height - 1; y++) {
		at(0, y);
		at(width - 1, y);
	}
	lum.sort((a, b) => a - b);
	return lum[Math.floor(lum.length / 2)]! >= 0.5 ? "light" : "dark";
}

/** A computed CSS color → its tone; null when fully transparent (the
 *  holder behind shows through). Anything unparseable is "unknown". */
export function toneFromCssColor(css: string): ArtifactTone | null {
	const v = css.trim().toLowerCase();
	if (v === "transparent") return null;
	const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
	if (!m) return "unknown";
	const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
	if (alpha === 0) return null;
	return relativeLuminance(Number(m[1]), Number(m[2]), Number(m[3])) >= 0.5 ? "light" : "dark";
}

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

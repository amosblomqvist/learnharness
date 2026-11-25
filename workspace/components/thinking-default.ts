"use client";

/**
 * The default-order resolution, CLIENT-SIDE (chunk 2, Platform interlude
 * bd68486): the UI mirrors defaultThinkingLevel from src/agent/models.ts
 * EXACTLY — first DEFAULT_THINKING_ORDER entry the model supports, else
 * the first supported level, else "off". One source of truth for the
 * ordering (the core barrel); this helper is its only client
 * interpretation, so a fresh model pick can auto-populate the SAME
 * level the engine would run for an unset record (owner ruling: the
 * ordering's ONLY purpose is first assignment — an explicit pick always
 * wins, and after a swap the WRITE clamps server-side, the signal
 * re-reads, and the clamped truth displays).
 */
import { DEFAULT_THINKING_ORDER } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Display labels for the levels (shared by every trigger that shows
 *  one). Lowercase, always (owner refinement round, 2026-09-24): the
 *  level strings ARE the display form — the settings menus render them
 *  raw, so the composer pill and setup dialog must match, never Title
 *  Case. */
export const THINKING_LABEL: Record<string, string> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** The level a fresh pick of `supported` populates with. Empty support
 *  (shouldn't happen — the catalog always reports at least ["off"])
 *  resolves "off", matching the server's fallback. */
export function defaultOrderLevel(supported: readonly ThinkingLevel[]): ThinkingLevel {
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** An EXPLICIT level always rides — even when the fresh pick's model
 *  doesn't support it: the WRITE clamps it to the nearest supported level
 *  server-side (Platform's interlude bd68486 — the owner's swap-400 case
 *  now just works), and the cross-surface signal re-reads so the clamped
 *  truth displays. The ordering only assigns FIRST: when no explicit
 *  level exists, a fresh model pick populates the ordering's level for
 *  that model (chunk 2: the unset state can never re-enter). */
export function populateLevel(
	explicit: ThinkingLevel | undefined,
	supported: readonly ThinkingLevel[],
): ThinkingLevel {
	return explicit ?? defaultOrderLevel(supported);
}
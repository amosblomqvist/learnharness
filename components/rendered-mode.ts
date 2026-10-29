"use client";
/**
 * The palette the app is rendering — the auto-invert switch reads it.
 * The app is dark-only today (<html class="dark"> in the root layout), so
 * this is a constant; a light mode swaps the body for the appearance
 * context's resolved mode.
 */
import type { RenderedMode } from "@/src/core";

export function useRenderedMode(): RenderedMode {
	return "dark";
}

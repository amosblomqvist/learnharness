"use client";

import { useSyncExternalStore } from "react";

/** The row id the model-missing click passes to openSettings. No key row
 *  carries it; the Keys section reads it as "bring the Dictation group into
 *  view" (it lives here so settings code need not import the dictation hook). */
export const DICTATION_PROVIDER_ROW_ID = "dictation-provider";

// The keyboard chain needs a synchronous answer; settings also subscribe
// so the language control locks from connecting until cleanup completes.
let active = false;
const listeners = new Set<() => void>();

export function isDictationActive(): boolean { return active; }

export function setDictationActive(next: boolean): void {
	if (active === next) return;
	active = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useDictationActive(): boolean {
	return useSyncExternalStore(subscribe, isDictationActive, () => false);
}

// A failed Parakeet recording kept for Retry. Separate from `active`: the
// run is over (Settings controls unlock) but Esc still belongs to dictation.
// Read synchronously by the keyboard chain, so no subscription is needed.
let retained = false;

export function isDictationRetained(): boolean { return retained; }

export function setDictationRetained(next: boolean): void {
	if (retained === next) return;
	retained = next;
}

"use client";

import { useSyncExternalStore } from "react";

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

/** Notified whenever the flag flips (read aloud stops itself when dictation starts). */
export function subscribeDictationActive(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useDictationActive(): boolean {
	return useSyncExternalStore(subscribeDictationActive, isDictationActive, () => false);
}

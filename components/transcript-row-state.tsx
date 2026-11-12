"use client";

import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";

/** Tiny presentation-state cache owned by one transcript. Virtual unmounts
 * must not reset a learner's disclosure choices; nothing is persisted to disk. */
export const TranscriptRowState = createContext<Map<string, unknown> | null>(null);

export function useTranscriptState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
	const cache = useContext(TranscriptRowState);
	const [value, setValue] = useState<T>(() => cache?.has(key) ? cache.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial);
	const update: Dispatch<SetStateAction<T>> = action => setValue(previous => {
		const next = typeof action === "function" ? (action as (value: T) => T)(previous) : action;
		cache?.set(key, next);
		return next;
	});
	return [value, update];
}

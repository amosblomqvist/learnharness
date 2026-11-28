"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

const STORAGE_PREFIX = "lh:draft:";
const cache = new Map<string, string>();
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flushBrowserDrafts() {
	clearTimeout(timer);
	timer = undefined;
	for (const [key, value] of pending) {
		try {
			if (value) window.localStorage.setItem(STORAGE_PREFIX + key, value);
			else window.localStorage.removeItem(STORAGE_PREFIX + key);
			pending.delete(key);
		} catch { /* The unsaved draft remains available in memory. */ }
	}
	if (!pending.size) window.removeEventListener("pagehide", flushBrowserDrafts);
}

export function rememberDraft(key: string | undefined, value: string, expected?: string) {
	if (!key) return;
	const stored = cache.get(key);
	if (stored === value || (expected !== undefined && stored !== expected)) return;
	cache.set(key, value);
	const desktop = window.lh?.drafts;
	if (desktop) {
		desktop.write(key, value);
		return;
	}
	if (!pending.size) window.addEventListener("pagehide", flushBrowserDrafts);
	pending.set(key, value);
	clearTimeout(timer);
	timer = setTimeout(flushBrowserDrafts, 800);
}

function readDraft(key: string): string | Promise<string> {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const desktop = window.lh?.drafts;
	if (desktop) {
		return desktop.read(key).then(value => {
			if (!cache.has(key)) cache.set(key, value);
			return cache.get(key)!;
		});
	}
	let value = "";
	try { value = window.localStorage.getItem(STORAGE_PREFIX + key) ?? ""; } catch { /* storage unavailable */ }
	cache.set(key, value);
	return value;
}

/** Reuse the live draft on remount and read only this field on a cold open. */
export function useSavedDraft(key: string | undefined, restore: (value: string) => void) {
	const restoreRef = useRef(restore);
	restoreRef.current = restore;
	useLayoutEffect(() => {
		if (!key) return;
		let mounted = true;
		const value = readDraft(key);
		if (typeof value === "string") {
			if (value) restoreRef.current(value);
		} else void value.then(draft => {
			if (mounted && draft) restoreRef.current(draft);
		}).catch(() => {});
		return () => { mounted = false; };
	}, [key]);
	return useCallback((value: string, expected?: string) => rememberDraft(key, value, expected), [key]);
}

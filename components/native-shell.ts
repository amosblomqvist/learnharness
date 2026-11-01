"use client";

/**
 * THE NATIVE SHELL BRIDGE (iPhone app 2.0): the iOS app owns the chrome —
 * tab bar, session list, navigation bar, composer and dictation — and shows
 * these pages inside it for what only the web renders (the transcript, the
 * question and practice docks, the graph, settings). Its User-Agent carries
 * `LHNativeShell/<v>`; older iPhone builds (the plain web wrapper) do not,
 * and keep the full web chrome.
 *
 * Page → app: `postToNative({type, …})` over the `lhNative` script message
 * handler. App → page: the app calls `window.lhNativeChat` (chat pages) and
 * dispatches `lh-native-open-settings` (any page). Both directions are
 * fire-and-forget; the server stays the source of truth.
 */
import { useEffect, useState } from "react";

declare global {
	interface Window {
		webkit?: { messageHandlers?: { lhNative?: { postMessage(message: unknown): void } } };
		/** Installed by the chat page while it is mounted inside the native shell. */
		lhNativeChat?: { stop(): void; openPlan(): void; find(): void };
		/** A settings section the app asked for before the dialog provider mounted. */
		lhNativePendingSettings?: string;
	}
}

export const NATIVE_OPEN_SETTINGS_EVENT = "lh-native-open-settings";

export function isNativeShell(): boolean {
	return typeof navigator !== "undefined" && navigator.userAgent.includes("LHNativeShell/");
}

/** False on the server and the first client render (hydration-safe). */
export function useNativeShell(): boolean {
	const [native, setNative] = useState(false);
	useEffect(() => setNative(isNativeShell()), []);
	return native;
}

export function postToNative(message: { type: string } & Record<string, unknown>): void {
	try {
		window.webkit?.messageHandlers?.lhNative?.postMessage(message);
	} catch {
		/* The app went away mid-call; nothing to tell. */
	}
}

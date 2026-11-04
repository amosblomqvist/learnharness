"use client";

import { useEffect } from "react";
import { studyTracker } from "@/components/study-tracker";

/** Wires the page's study tracker to the DOM and points it at this chat.
 *  The tracker singleton outlives Chat remounts (chat switches). */
export function useStudyTracker(chatId: string, started: boolean): void {
	useEffect(() => {
		const tracker = studyTracker();
		const onInput = (e: Event) => tracker.input(e as unknown as { type: string; screenX?: number; screenY?: number });
		const onFocus = () => tracker.focus();
		const onBlur = () => tracker.blur();
		const onVisibility = () => tracker.visibility(document.hidden);
		const onPageHide = () => tracker.unload();
		const onPageShow = (e: PageTransitionEvent) => {
			if (e.persisted && document.hasFocus()) tracker.focus();
		};
		const inputEvents = ["keydown", "pointerdown", "wheel", "touchmove", "pointermove"] as const;
		for (const type of inputEvents) window.addEventListener(type, onInput, { capture: true, passive: true });
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onPageHide);
		window.addEventListener("pageshow", onPageShow);
		return () => {
			for (const type of inputEvents) window.removeEventListener(type, onInput, { capture: true });
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onPageHide);
			window.removeEventListener("pageshow", onPageShow);
			tracker.setChat(null, false);
		};
	}, []);

	useEffect(() => {
		studyTracker().setChat(chatId, started);
	}, [chatId, started]);
}

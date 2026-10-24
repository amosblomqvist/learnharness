"use client";

import { useEffect } from "react";

/**
 * THE ONE-ESC LAW (owner keyboard round 2026-10-06): a surfaced layer (the
 * plan popup, a diagram or image focus) claims Esc at the DOCUMENT level,
 * so one Esc is exactly one action. The window-level chain (dictation
 * cancel, then abort) is the fallback for when nothing is surfaced; a
 * window listener could never stop it, because same-node listeners all
 * fire (the plan-open-while-dictating double-act).
 */
export function useEscapeClaim(onEscape: () => void): void {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onEscape();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onEscape]);
}

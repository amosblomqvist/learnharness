"use client";

/**
 * Small-screen detection (mobile-web, 2026-10-29).
 *
 * Matches Tailwind's `md` breakpoint (767px and below = phone). Returns false
 * during SSR/first paint — the desktop layout is the safe default, and the
 * mobile shell (drawer, sheets) only exists after mount, which is exactly when
 * a user can interact with it.
 */

import { useEffect, useState } from "react";

export const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
	const [mobile, setMobile] = useState(false);
	useEffect(() => {
		// Server render, jsdom stubs and old browsers may lack matchMedia —
		// the desktop layout is the safe default there.
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(MOBILE_QUERY);
		const update = () => setMobile(mq.matches);
		update();
		mq.addEventListener?.("change", update);
		return () => mq.removeEventListener?.("change", update);
	}, []);
	return mobile;
}

"use client";

/**
 * Session guard (mobile-web, 2026-10-29): the client half of the gate.
 *
 * - On mount: ask /api/auth/me; no account ⇒ go to /login.
 * - For the life of the shell: any API 401 (expired/revoked cookie, disabled
 *   account) sends the tab back to /login instead of leaving dead panels.
 *
 * Skipped inside the Electron shell, which authenticates with its own
 * capability header and has no login screen.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function SessionGuard() {
	const router = useRouter();
	useEffect(() => {
		if (typeof window !== "undefined" && window.lh) return;
		let cancelled = false;
		void fetch("/api/auth/me", { cache: "no-store" })
			.then((res) => (res.ok ? (res.json() as Promise<{ user: unknown }>) : { user: null }))
			.then((body) => {
				if (!cancelled && !body.user) router.replace("/login");
			})
			.catch(() => undefined);

		// Bind to window: calling the captured reference unbound throws
		// "TypeError: Failed to fetch" in Chromium and breaks Next's RSC
		// payload fetches (caught in the first live run, 2026-10-29).
		const original = window.fetch.bind(window);
		window.fetch = async (...args: Parameters<typeof fetch>) => {
			const response = await original(...args);
			if (response.status === 401) router.replace("/login");
			return response;
		};
		return () => {
			cancelled = true;
			window.fetch = original;
		};
	}, [router]);
	return null;
}

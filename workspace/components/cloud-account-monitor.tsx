"use client";
import { useEffect } from "react";

/** Navigation drops old account views when a system-browser login completes. */
export function CloudAccountMonitor({ initialProfile }: { initialProfile: string }) {
	useEffect(() => {
		let profile = initialProfile;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function check() {
			try {
				const response = await fetch("/api/labs/cloud", { cache: "no-store" });
				if (!response.ok) return;
				const body = await response.json() as { profile?: string };
				if (stopped || !body.profile) return;
				if (profile !== undefined && profile !== body.profile) { window.location.assign("/"); return; }
				profile = body.profile;
			} catch { /* Local app restarts and offline operation are expected. */ }
			finally { if (!stopped) timer = setTimeout(() => { void check(); }, 5000); }
		}
		void check();
		return () => { stopped = true; clearTimeout(timer); };
	}, [initialProfile]);
	return null;
}

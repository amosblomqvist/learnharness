"use client";

/**
 * The signed-in account, client side (mobile-web, 2026-10-29).
 * One module-level cache + one in-flight request: the sidebar, the settings
 * dialog and the accounts section all ask the same question.
 */

import { useEffect, useState } from "react";

export type Me = {
	id: string;
	name: string;
	email: string;
	role: "admin" | "user";
	createdAt: string;
	disabled: boolean;
};

let cached: Me | null | undefined;
let inflight: Promise<Me | null> | null = null;

async function load(): Promise<Me | null> {
	if (cached !== undefined) return cached;
	if (!inflight) {
		inflight = fetch("/api/auth/me", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ user: Me | null }>) : { user: null }))
			.then((body) => {
				cached = body.user;
				return body.user;
			})
			.catch(() => {
				cached = null;
				return null;
			})
			.finally(() => {
				inflight = null;
			});
	}
	return inflight;
}

/** Clear the cache (after login/logout/account edits). */
export function invalidateMe(): void {
	cached = undefined;
	inflight = null;
}

export function useMe(): { user: Me | null; loading: boolean } {
	const [user, setUser] = useState<Me | null>(cached ?? null);
	const [loading, setLoading] = useState(cached === undefined);
	useEffect(() => {
		let alive = true;
		void load().then((value) => {
			if (!alive) return;
			setUser(value);
			setLoading(false);
		});
		return () => {
			alive = false;
		};
	}, []);
	return { user, loading };
}

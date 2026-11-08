"use client";

import { createContext, useLayoutEffect, useState, type ReactNode } from "react";

/** The host's content column, excluding the sidebar. Portals retain app contexts. */
export const HostContentRootContext = createContext<HTMLElement | null>(null);

/** Private host route instance, shared with widgets portaled outside page trees.
 * Cleanup expires an opening even when Next retains its source in Activity. */
export interface HostRouteLifetime { pathname: string; signal: AbortSignal }
export const HostRouteLifetimeContext = createContext<HostRouteLifetime | null>(null);

export function HostRouteLifetimeProvider({ pathname, children }: { pathname: string; children: ReactNode }) {
	const [current, setCurrent] = useState<HostRouteLifetime | null>(null);
	useLayoutEffect(() => {
		const lifetime = new AbortController();
		setCurrent({ pathname, signal: lifetime.signal });
		return () => lifetime.abort();
	}, [pathname]);
	return <HostRouteLifetimeContext.Provider value={current?.pathname === pathname ? current : null}>{children}</HostRouteLifetimeContext.Provider>;
}

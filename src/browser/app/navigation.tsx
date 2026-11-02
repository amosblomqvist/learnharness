/**
 * The phone build's client router — the stand-in for `next/navigation` and
 * `next/link` (scripts/build-mobile.mjs aliases both here). The components
 * use only push / replace / back, usePathname and <Link>, so a small
 * history-API router covers them; the page switch lives in ./app.tsx.
 */
"use client";

import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

type Location = { pathname: string; search: string };

const read = (): Location => ({ pathname: location.pathname, search: location.search });

const listeners = new Set<(loc: Location) => void>();
const notify = () => {
	const loc = read();
	for (const l of listeners) l(loc);
};

export function navigate(href: string, mode: "push" | "replace" = "push"): void {
	const url = new URL(href, location.href);
	if (url.origin !== location.origin) {
		location.assign(url.href);
		return;
	}
	const next = url.pathname + url.search + url.hash;
	if (mode === "push") history.pushState(null, "", next);
	else history.replaceState(null, "", next);
	notify();
	window.scrollTo(0, 0);
}

const LocationContext = createContext<Location | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
	const [loc, setLoc] = useState<Location>(read);
	useEffect(() => {
		const onPop = () => notify();
		listeners.add(setLoc);
		window.addEventListener("popstate", onPop);
		return () => {
			listeners.delete(setLoc);
			window.removeEventListener("popstate", onPop);
		};
	}, []);
	return <LocationContext.Provider value={loc}>{children}</LocationContext.Provider>;
}

export function useLocation(): Location {
	return useContext(LocationContext) ?? read();
}

// ─── next/navigation surface ────────────────────────────────────────────────

const router = {
	push: (href: string) => navigate(href, "push"),
	replace: (href: string) => navigate(href, "replace"),
	back: () => history.back(),
	forward: () => history.forward(),
	refresh: () => notify(),
	prefetch: () => {},
};

export function useRouter() {
	return router;
}

export function usePathname(): string {
	return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
	return new URLSearchParams(useLocation().search);
}

export function useParams(): Record<string, string> {
	return {};
}

export function redirect(href: string): never {
	navigate(href, "replace");
	throw new Error(`redirect to ${href}`);
}

export function notFound(): never {
	throw new Error("not found");
}

// ─── next/link surface ──────────────────────────────────────────────────────

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	href: string;
	prefetch?: boolean;
	replace?: boolean;
	scroll?: boolean;
};

export function Link({ href, prefetch: _prefetch, replace, scroll: _scroll, onClick, children, ...rest }: LinkProps) {
	return (
		<a
			href={href}
			{...rest}
			onClick={(e) => {
				onClick?.(e);
				if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
				e.preventDefault();
				navigate(href, replace ? "replace" : "push");
			}}
		>
			{children}
		</a>
	);
}

export default Link;

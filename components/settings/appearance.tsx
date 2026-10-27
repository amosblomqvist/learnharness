"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The ONE thing the
 * variables can't reach — the mode — is dark-only this wave (the light
 * palette is designed in the later design wave; <html class="dark"> is
 * static in app/layout.tsx).
 *
 * OMARCHY THEME (2026-10-26): with appearance.theme = "omarchy" the palette
 * comes from the desktop's theme file (GET /api/theme/omarchy, shape in
 * core/system-theme.ts) instead of the background derivation — every
 * palette token, the mode included: a light Omarchy theme drops the dark
 * class. "theme-changed" (the server's watch on that file) refetches it,
 * so an Omarchy theme switch retints open windows live. Selected but no
 * file = the app's own palette.
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	FACTORY_SETTINGS,
	sanitizeSystemTheme,
	systemThemeVars,
	type AppearanceSettings,
	type SystemTheme,
} from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		theme: delta?.theme ?? f.theme,
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** One channel clamped on the dark curve: additive offsets matching today's
 *  hand-picked palette (#141414 → card #1c1c1c (+8) → accent #2a2a2a (+22)
 *  → border #434343 (+47)) — the "per-mode derivation in code" the schema
 *  promises, as the thinnest curve that keeps the palette's relationships. */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.min(255, c + add).toString(16).padStart(2, "0")).join("")}`;
}

/** The derived palette a chosen background implies (dark curve): background
 *  itself, the raised surfaces (card/popover/secondary/muted, +8), the
 *  accent (+22), the edges (border/input, +47), and primary-foreground
 *  (the inverted text on primary = the background's own color, as today). */
export function derivedPalette(background: string): Record<string, string> {
	const card = raise(background, 8);
	const accent = raise(background, 22);
	const border = raise(background, 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** The palette in effect: the Omarchy theme when it is selected AND its
 *  file was read, otherwise null (the app's own palette). Pure. */
export function activeSystemTheme(
	a: ReturnType<typeof resolveAppearance>,
	systemTheme: SystemTheme | null,
): SystemTheme | null {
	return a.theme === "omarchy" ? systemTheme : null;
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. An active
 *  Omarchy theme replaces the background derivation; type and emphasis
 *  settings still apply on top. Pure — exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	systemTheme: SystemTheme | null = null,
): Record<string, string> {
	const vars: Record<string, string> = {};
	const theme = activeSystemTheme(a, systemTheme);
	if (theme !== null) Object.assign(vars, systemThemeVars(theme));
	else if (a.background !== null) Object.assign(vars, derivedPalette(a.background));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The Omarchy theme file's palette; null = no usable file. */
	systemTheme: SystemTheme | null;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	systemTheme: null,
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const [systemTheme, setSystemTheme] = useState<SystemTheme | null>(null);
	const appliedRef = useRef<string>("");

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta), systemTheme), [delta, systemTheme]);
	// The one thing the vars can't reach: Tailwind's dark variant keys off
	// <html class="dark">, so a light Omarchy theme has to drop the class.
	const light = activeSystemTheme(resolveAppearance(delta), systemTheme)?.mode === "light";
	useEffect(() => {
		document.documentElement.classList.toggle("dark", !light);
	}, [light]);

	// The Omarchy theme file: read on load, re-read whenever the server's
	// watch reports a change (and after a reconnect, which may have missed
	// one). A failed read keeps the last palette rather than flashing back.
	const loadSystemTheme = useCallback(() => {
		fetch("/api/theme/omarchy")
			.then((r) => r.json())
			.then((body: { theme?: unknown }) => setSystemTheme(sanitizeSystemTheme(body.theme)))
			.catch(() => {/* keep the last palette */});
	}, []);
	useEffect(loadSystemTheme, [loadSystemTheme]);
	useServerEvent("theme-changed", loadSystemTheme);
	useServerResync(loadSystemTheme);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), systemTheme, onAppearanceChange }),
		[delta, systemTheme, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
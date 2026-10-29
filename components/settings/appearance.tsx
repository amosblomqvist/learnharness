"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The ONE thing the
 * variables can't reach — the mode — is a class on <html> (light-mode
 * wave, 2026-10-29): app/layout.tsx server-renders `dark`/`light` plus
 * data-lh-mode from the settings record, an inline <head> script resolves
 * System against the OS before first paint, and this provider owns every
 * live switch after that (a settings write, an OS flip under System).
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS,
	resolveRenderedMode,
	variantPalette,
	type AppearanceMode,
	type AppearanceSettings,
	type RenderedMode,
} from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		lightBackground: delta?.lightBackground ?? f.lightBackground,
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

/** The surfaces a chosen background moves — the inks stay the stylesheet's. */
const SURFACE_TOKENS = [
	"--background",
	"--card",
	"--popover",
	"--secondary",
	"--muted",
	"--accent",
	"--border",
	"--input",
	"--primary-foreground",
] as const;

/** The derived palette a chosen background implies along one variant's
 *  curve (src/core/appearance-palette.ts): background itself, the raised
 *  surfaces (card/popover/secondary/muted), the accent, the edges
 *  (border/input), and primary-foreground (the inverted text on primary =
 *  the background's own color). */
export function derivedPalette(background: string, mode: RenderedMode = "dark"): Record<string, string> {
	const full = variantPalette(mode, background);
	return Object.fromEntries(SURFACE_TOKENS.map((t) => [t, full[t]!]));
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Each
 *  variant derives from its OWN background (dark `background`, light
 *  `lightBackground`), so a dark custom palette never survives a switch to
 *  light. Pure — exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	mode: RenderedMode = "dark",
): Record<string, string> {
	const vars: Record<string, string> = {};
	const bg = mode === "dark" ? a.background : a.lightBackground;
	if (bg !== null) Object.assign(vars, derivedPalette(bg, mode));
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
	/** The variant actually on screen — System resolved against the OS. */
	resolvedMode: RenderedMode;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	resolvedMode: "dark",
	onAppearanceChange: () => {},
});

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribePrefersDark(onChange: () => void): () => void {
	const mq = window.matchMedia(DARK_QUERY);
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}

/** The OS preference as an external store: the server snapshot is dark (the
 *  layout's default), so hydration matches the server HTML and React
 *  re-renders with the real value right after — no mismatch under System. */
function usePrefersDark(): boolean {
	return useSyncExternalStore(subscribePrefersDark, () => window.matchMedia(DARK_QUERY).matches, () => true);
}

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initialMode,
}: {
	children: React.ReactNode;
	/** The mode the layout server-rendered — holds until the record arrives. */
	initialMode: AppearanceMode;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const appliedRef = useRef<string>("");
	const prefersDark = usePrefersDark();
	const mode: AppearanceMode = delta?.mode ?? initialMode;
	const resolvedMode = resolveRenderedMode(mode, prefersDark);

	// The mode lives on <html>: data-lh-mode for the pre-paint script on the
	// next load, the class for every `.dark`/`.light` rule and variant.
	// System reads the OS here, not resolvedMode: during hydration that still
	// holds the server snapshot (dark) and would undo the head script's class
	// for a commit. resolvedMode stays a dep so an OS flip re-runs this.
	useEffect(() => {
		const root = document.documentElement;
		const dark = mode === "system" ? window.matchMedia(DARK_QUERY).matches : mode === "dark";
		root.dataset.lhMode = mode;
		root.classList.toggle("dark", dark);
		root.classList.toggle("light", !dark);
	}, [mode, resolvedMode]);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta), resolvedMode), [delta, resolvedMode]);
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
		() => ({ appearance: resolveAppearance(delta), resolvedMode, onAppearanceChange }),
		[delta, resolvedMode, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
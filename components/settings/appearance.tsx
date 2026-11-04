"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19; theme wave,
 * 2026-11-04): the settings record's appearance section — the active
 * theme, the color overrides, the type knobs — applied as RUNTIME CSS
 * variables on <html>, plus the `dark`/`light` class the theme declares.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--background, --font-prose, --lh-ink-strong, …), so
 * application is setProperty and nothing re-renders. First paint is the
 * layout's job: app/layout.tsx server-renders the theme's class and color
 * variables on <html> from the record, so no frame ever shows the wrong
 * theme; this provider owns every live switch after that.
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	BUILTIN_THEMES,
	effectiveColors,
	FACTORY_SETTINGS,
	resolveTheme,
	themeVars,
	type AppearanceSettings,
	type RenderedMode,
	type Theme,
	type ThemeColors,
} from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		theme: delta?.theme ?? f.theme,
		background: delta?.background ?? f.background,
		colors: delta?.colors ?? f.colors,
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

/** Reading fonts the app ships itself (next/font in app/layout.tsx), by
 *  family name → the CSS variable carrying the bundled face. They work
 *  without being installed: an installed copy wins by name, the bundled
 *  one fills in otherwise. Exported for the font menu and tests. */
export const BUNDLED_READING_FONTS: Readonly<Record<string, string>> = {
	"JetBrains Mono": "var(--font-jetbrains)",
};

/** THE mapping: resolved appearance + active theme → the CSS variables to
 *  set on <html>. Colors: the theme with every override applied
 *  (core/themes.ts effectiveColors → themeVars). Type knobs: absent
 *  entries leave the stylesheet value in place. Pure — exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	theme: Theme,
): Record<string, string> {
	const vars: Record<string, string> = themeVars(effectiveColors(theme, a), theme.mode);
	if (a.fontFamily !== null) {
		const bundled = BUNDLED_READING_FONTS[a.fontFamily];
		vars["--font-prose"] = `"${a.fontFamily}", ${bundled ? `${bundled}, ` : ""}var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown heading weight (the emphasis inks ride the theme colors).
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
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
	/** Resolved appearance (the record's delta over the factory). */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The raw record delta — what a section write composes onto. */
	delta: AppearanceSettings | undefined;
	/** The active theme's variant (the class on <html>). */
	resolvedMode: RenderedMode;
	/** The active theme (Default when the record's id is gone). */
	activeTheme: Theme;
	/** The active theme with every override applied — what is on screen. */
	colors: ThemeColors;
	/** Presets, then imported customs. */
	themes: Theme[];
	/** Re-read the catalog after an import or a removal. */
	refreshThemes: () => Promise<void>;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const DEFAULT_CONTEXT_THEME = resolveTheme(undefined);

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	delta: undefined,
	resolvedMode: DEFAULT_CONTEXT_THEME.mode,
	activeTheme: DEFAULT_CONTEXT_THEME,
	colors: DEFAULT_CONTEXT_THEME.colors,
	themes: [...BUILTIN_THEMES],
	refreshThemes: async () => {},
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initialAppearance,
	initialTheme,
}: {
	children: React.ReactNode;
	/** The record's appearance delta, read server-side by the layout. */
	initialAppearance: AppearanceSettings | undefined;
	/** The active theme the layout resolved (a custom one included). */
	initialTheme: Theme;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(initialAppearance);
	const [themes, setThemes] = useState<Theme[]>(() =>
		initialTheme.builtin ? [...BUILTIN_THEMES] : [...BUILTIN_THEMES, initialTheme],
	);
	const appliedRef = useRef<string>("");
	const appearance = useMemo(() => resolveAppearance(delta), [delta]);
	const activeTheme = useMemo(
		() => resolveTheme(appearance.theme, themes.filter((t) => !t.builtin)),
		[appearance.theme, themes],
	);
	const mode = activeTheme.mode;
	const colors = useMemo(() => effectiveColors(activeTheme, appearance), [activeTheme, appearance]);

	// The mode lives on <html> as a class, for every `.dark`/`.light` rule
	// and variant. A LAYOUT effect (like the vars below): descendants'
	// passive effects run after it, so anything reading computed tokens
	// (the graph canvas) sees the new mode, and the swap lands before paint.
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.classList.toggle("dark", mode === "dark");
		root.classList.toggle("light", mode === "light");
	}, [mode]);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(appearance, activeTheme), [appearance, activeTheme]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty font = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever. Every
	// name this effect has ever set is tracked; names absent from the new
	// set are removed so the stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useLayoutEffect(() => {
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

	// The desktop shell's native chrome (window background, Windows/Linux
	// control overlay) follows the theme — absent in a browser.
	const background = colors.background;
	useEffect(() => {
		window.lh?.setAppearance?.({ mode, background });
	}, [mode, background]);

	const refreshThemes = useCallback(async () => {
		try {
			const res = await fetch("/api/themes");
			if (!res.ok) return;
			const body = (await res.json()) as { themes?: Theme[] };
			if (Array.isArray(body.themes)) setThemes(body.themes);
		} catch {
			/* the presets stay — not worth a crash */
		}
	}, []);

	// One catalog read per app load (the imported customs).
	useEffect(() => {
		void refreshThemes();
	}, [refreshThemes]);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance, delta, resolvedMode: mode, activeTheme, colors, themes, refreshThemes, onAppearanceChange }),
		[appearance, delta, mode, activeTheme, colors, themes, refreshThemes, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

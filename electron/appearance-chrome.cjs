"use strict";
/**
 * NATIVE CHROME FOLLOWS THE MODE (light-mode wave, 2026-10-29): the pure
 * half of main.cjs's appearance handling, split out so it can be tested.
 * The window's own background (resize lag, first paint) and the
 * Windows/Linux control overlay paint the rendered variant. Defaults mirror
 * the app's palettes (src/core/appearance-palette.ts MODE_DEFAULT_BACKGROUND).
 */
const path = require("node:path");

const WINDOW_CHROME = {
	dark: { background: "#141414", symbol: "#e5e5e5" },
	light: { background: "#f5f5f3", symbol: "#1a1a1a" },
};
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** The appearance slice the renderer reports (or settings.json holds),
 *  reduced to what the chrome needs. Anything unknown → the dark factory. */
function normalizeAppearance(a) {
	return {
		mode: a?.mode === "light" || a?.mode === "system" ? a.mode : "dark",
		background: typeof a?.background === "string" && HEX.test(a.background) ? a.background : null,
	};
}

/** nativeTheme.themeSource for a mode. Dark keeps "system", Electron's
 *  default before light mode existed: native menus, dialogs and the demo
 *  iframes' prefers-color-scheme keep following the OS, as they always
 *  did. Light pins "light"; System follows the OS. */
function themeSourceFor(mode) {
	return mode === "light" ? "light" : "system";
}

/** Native colors for the rendered variant. Pinned modes render their own
 *  variant; System takes the OS's (nativeTheme.shouldUseDarkColors). The
 *  custom background is the dark variant's; light is always the paper. */
function chromeColors(appearance, osDark) {
	const mode = appearance.mode === "system" ? (osDark ? "dark" : "light") : appearance.mode;
	const custom = mode === "dark" ? appearance.background : null;
	return { color: custom ?? WINDOW_CHROME[mode].background, symbolColor: WINDOW_CHROME[mode].symbol };
}

/** The data directory the SERVER reads settings.json from. Packaged: the
 *  dir main passes to its child as LH_DATA_DIR. Dev (LH_DEV_URL): `next dev`
 *  runs on its own, so mirror config.ts: LH_DATA_DIR, else the repo's data/. */
function serverDataDir({ devUrl, env, packagedDataDir, repoRoot }) {
	if (!devUrl) return packagedDataDir;
	return env.LH_DATA_DIR ? path.resolve(env.LH_DATA_DIR) : path.join(repoRoot, "data");
}

module.exports = { WINDOW_CHROME, normalizeAppearance, themeSourceFor, chromeColors, serverDataDir };

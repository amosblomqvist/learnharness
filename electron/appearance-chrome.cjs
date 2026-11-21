"use strict";
/** Native appearance must be ready before creating a window, independently
 * of the renderer's first report. Keep the small preset boot projection
 * pinned to core's full catalog in appearance-chrome.test.ts. */
const fs = require("node:fs");
const path = require("node:path");

const PRESET_APPEARANCE = {
	default: { mode: "dark", background: "#141414" },
	"catppuccin-latte": { mode: "light", background: "#eff1f5" },
	"catppuccin-frappe": { mode: "dark", background: "#303446" },
	"catppuccin-macchiato": { mode: "dark", background: "#24273a" },
	"catppuccin-mocha": { mode: "dark", background: "#1e1e2e" },
	"rose-pine": { mode: "dark", background: "#191724" },
	"rose-pine-dawn": { mode: "light", background: "#faf4ed" },
	"gruvbox-dark": { mode: "dark", background: "#282828" },
	ivory: { mode: "light", background: "#faf9f5" },
	pastel: { mode: "light", background: "#f2f0e8" },
	"nvchad-onedark": { mode: "dark", background: "#1e222a" },
};
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const COLOR_KEYS = ["background", "surface", "border", "text", "textMuted", "accent", "bold", "italic", "code", "error", "success", "warning"];

function normalizeAppearance(a) {
	return {
		mode: a?.mode === "light" ? "light" : "dark",
		background: typeof a?.background === "string" && HEX.test(a.background) ? a.background : null,
	};
}

/** Preserve Electron's pre-theme OS-following menus/dialogs for dark.
 * The app/window palette itself remains pinned to the selected theme. */
function themeSourceFor(mode) {
	return mode === "light" ? "light" : "system";
}

/** Mirror the server's data path in external-dev mode, not the shell's
 * separate -dev userData. Packaged uses the path given to its child. */
function serverDataDir({ devUrl, env, packagedDataDir, repoRoot }) {
	if (!devUrl) return packagedDataDir;
	return env.LH_DATA_DIR ? path.resolve(env.LH_DATA_DIR) : path.join(repoRoot, "data");
}

function readAppearance(dataDir) {
	let a;
	try { a = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"))?.appearance; }
	catch { /* absent/corrupt record = factory */ }
	const id = typeof a?.theme === "string" ? a.theme : undefined;
	let theme = Object.hasOwn(PRESET_APPEARANCE, id) ? PRESET_APPEARANCE[id] : PRESET_APPEARANCE.default;
	if (typeof id === "string" && id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && !Object.hasOwn(PRESET_APPEARANCE, id)) {
		try {
			const custom = JSON.parse(fs.readFileSync(path.join(dataDir, "themes", `${id}.json`), "utf8"));
			// Match the data-only core parser: malformed files render Default,
			// including files with a valid background but an invalid other ink.
			if (typeof custom?.name === "string" && custom.name.trim() && /[a-z0-9]/i.test(custom.name.normalize("NFD")) &&
				(custom.mode === "dark" || custom.mode === "light") && custom.colors && !Array.isArray(custom.colors) &&
				COLOR_KEYS.every(key => typeof custom.colors[key] === "string" && HEX.test(custom.colors[key]))) {
				theme = { mode: custom.mode, background: custom.colors.background };
			}
		} catch { /* missing/invalid selected file = Default */ }
	}
	return { mode: theme.mode, background: normalizeAppearance(a).background ?? theme.background };
}

function luminance(hex) {
	const full = hex.length === 4 ? hex.slice(1).split("").map(c => c + c).join("") : hex.slice(1);
	return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
		const c = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
		return sum + weight * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	}, 0);
}

/** Title-bar glyph contrast follows the actual final background, including
 * overrides that do not match the selected theme's dark/light label. */
function chromeColors(appearance) {
	const color = appearance.background ?? (appearance.mode === "light" ? "#f5f5f3" : "#141414");
	const bg = luminance(color);
	const contrast = ink => (Math.max(bg, luminance(ink)) + 0.05) / (Math.min(bg, luminance(ink)) + 0.05);
	return { color, symbolColor: contrast("#e5e5e5") > contrast("#1a1a1a") ? "#e5e5e5" : "#1a1a1a" };
}

module.exports = { PRESET_APPEARANCE, COLOR_KEYS, normalizeAppearance, themeSourceFor, serverDataDir, readAppearance, chromeColors };

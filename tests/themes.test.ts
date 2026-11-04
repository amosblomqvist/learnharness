/**
 * The theme wave's pure core (src/core/themes.ts): the import validator,
 * the presets, the theme → CSS-token adapter (Default pinned against the
 * app/globals.css literals), override precedence across the two override
 * homes, and the export.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
	BUILTIN_THEMES,
	DEFAULT_THEME,
	effectiveColors,
	exportThemeFile,
	parseThemeFile,
	resolveTheme,
	sanitizeThemeFile,
	THEME_COLOR_KEYS,
	themeIdFromName,
	themeVars,
	type Theme,
} from "../src/core/index.ts";

const mocha = BUILTIN_THEMES.find((t) => t.id === "catppuccin-mocha")!;
const validFile = { name: "My Ayu", mode: "dark", colors: { ...mocha.colors } };

describe("theme files — the import validator", () => {
	it("accepts the documented shape and drops unknown keys", () => {
		const out = sanitizeThemeFile({ ...validFile, author: "me", colors: { ...validFile.colors, extra: "#000" } });
		assert.deepEqual(out, validFile);
	});

	it("names the first bad field", () => {
		const { error: _drop, ...noError } = validFile.colors;
		const cases: Array<[unknown, RegExp]> = [
			[[1], /JSON object/],
			[{ ...validFile, name: "  " }, /name/],
			[{ ...validFile, mode: "sepia" }, /mode/],
			[{ ...validFile, colors: "red" }, /colors must be an object/],
			[{ ...validFile, colors: noError }, /colors\.error/],
			[{ ...validFile, colors: { ...validFile.colors, text: "white" } }, /colors\.text/],
		];
		for (const [raw, message] of cases) {
			const parsed = parseThemeFile(raw);
			assert.equal(parsed.ok, false, JSON.stringify(raw));
			assert.match(!parsed.ok ? parsed.error : "", message);
		}
	});

	it("ids are name slugs, accents folded", () => {
		assert.equal(themeIdFromName("Rosé Pine Moon"), "rose-pine-moon");
		assert.equal(themeIdFromName("  My   Ayu!! "), "my-ayu");
		assert.equal(themeIdFromName("!!!"), "");
	});
});

describe("presets", () => {
	it("every preset is a valid theme file with a unique id matching its name", () => {
		const ids = new Set<string>();
		for (const t of BUILTIN_THEMES) {
			assert.ok(sanitizeThemeFile(t), t.id);
			assert.ok(!ids.has(t.id), `duplicate ${t.id}`);
			ids.add(t.id);
			assert.equal(t.id, themeIdFromName(t.name));
			assert.equal(t.builtin, true);
		}
		assert.deepEqual([...ids], [
			"default", "catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha",
			"rose-pine", "rose-pine-moon", "rose-pine-dawn", "gruvbox-dark", "gruvbox-light", "ivory", "pastel", "nvchad-onedark",
		]);
	});

	it("an unknown or removed id resolves to Default", () => {
		assert.equal(resolveTheme(undefined), DEFAULT_THEME);
		assert.equal(resolveTheme("gone"), DEFAULT_THEME);
		const custom: Theme = { ...validFile, mode: "dark", id: "my-ayu", builtin: false };
		assert.equal(resolveTheme("my-ayu", [custom]), custom);
	});
});

/** The declarations of the block opening with `selector {`. */
function cssBlock(css: string, selector: string): Map<string, string> {
	const start = css.indexOf(`${selector} {`);
	assert.ok(start >= 0, `missing ${selector}`);
	const body = css.slice(start, css.indexOf("}", start));
	const out = new Map<string, string>();
	for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
	return out;
}

describe("themeVars — the adapter", () => {
	it("Default reproduces app/globals.css's literals exactly", () => {
		const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		const block = cssBlock(css, ":root,\n.dark");
		for (const [token, value] of Object.entries(themeVars(DEFAULT_THEME.colors, "dark"))) {
			assert.equal(block.get(token), value, token);
		}
	});

	it("the hover surface derives from surface; the theme accent goes to --lh-accent", () => {
		const dark = themeVars(mocha.colors, "dark");
		assert.equal(dark["--accent"], "#3f4052", "surface #313244 + 14 per channel");
		assert.equal(dark["--lh-accent"], mocha.colors.accent);
		assert.equal(dark["--ring"], mocha.colors.accent);
		const latte = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte")!;
		assert.equal(themeVars(latte.colors, "light")["--accent"], "#d8dbe1", "light hovers darken: mantle #e6e9ef − 14");
	});

	it("emphasis and status inks come straight from the theme", () => {
		const v = themeVars(mocha.colors, "dark");
		assert.equal(v["--lh-ink-strong"], mocha.colors.bold);
		assert.equal(v["--lh-ink-italic"], mocha.colors.italic);
		assert.equal(v["--lh-ink-code"], mocha.colors.code);
		assert.equal(v["--lh-error"], mocha.colors.error);
		assert.equal(v["--destructive"], mocha.colors.error);
		assert.equal(v["--lh-success"], mocha.colors.success);
		assert.equal(v["--lh-warning"], mocha.colors.warning);
	});
});

describe("effectiveColors — overrides over the theme", () => {
	it("no overrides = the theme", () => {
		assert.deepEqual(effectiveColors(mocha, undefined), mocha.colors);
		assert.deepEqual(effectiveColors(mocha, { background: null, colors: { warning: null } }), mocha.colors);
	});

	it("each override wins from its home: background, mdRendering inks, colors", () => {
		const c = effectiveColors(mocha, {
			background: "#101010",
			mdRendering: { boldColor: "#ff0000", italicColor: "#00ff00" },
			colors: { warning: "#fab387", surface: "#222" },
		});
		assert.equal(c.background, "#101010");
		assert.equal(c.bold, "#ff0000");
		assert.equal(c.italic, "#00ff00");
		assert.equal(c.warning, "#fab387");
		assert.equal(c.surface, "#222");
		assert.equal(c.text, mocha.colors.text);
	});
});

describe("graph edges", () => {
	it("draw in each theme's muted text, never the highlight accent", () => {
		for (const t of BUILTIN_THEMES) {
			assert.equal(themeVars(t.colors, t.mode)["--muted-foreground"], t.colors.textMuted, t.id);
		}
		const view = fs.readFileSync(new URL("../components/graph-view.tsx", import.meta.url), "utf8");
		assert.match(view, /edge: tokenHex\("--muted-foreground"\)/);
	});
});

describe("exportThemeFile", () => {
	it("is the theme with every override applied, all 12 keys", () => {
		const out = exportThemeFile(mocha, { colors: { warning: "#fab387" } });
		assert.deepEqual(out, { name: "Catppuccin Mocha", mode: "dark", colors: { ...mocha.colors, warning: "#fab387" } });
		assert.deepEqual(Object.keys(out.colors).sort(), [...THEME_COLOR_KEYS].sort());
		assert.ok(sanitizeThemeFile(out), "an export is always importable");
	});
});

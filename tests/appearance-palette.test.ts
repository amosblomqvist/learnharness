/**
 * The light-mode wave's pure core (src/core/appearance-palette.ts): which
 * variant renders for a mode, the pre-paint System script, and the
 * per-variant palettes (pinned against app/globals.css's defaults).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
	MODE_DEFAULT_BACKGROUND,
	resolveRenderedMode,
	SYSTEM_MODE_SCRIPT,
	variantPalette,
	type RenderedMode,
} from "../src/core/appearance-palette.ts";

describe("appearance mode resolution", () => {
	it("pinned modes ignore the OS; system follows it", () => {
		assert.equal(resolveRenderedMode("dark", false), "dark");
		assert.equal(resolveRenderedMode("light", true), "light");
		assert.equal(resolveRenderedMode("system", true), "dark");
		assert.equal(resolveRenderedMode("system", false), "light");
	});

	it("the pre-paint script only acts on data-lh-mode=system", () => {
		assert.match(SYSTEM_MODE_SCRIPT, /lhMode/);
		assert.match(SYSTEM_MODE_SCRIPT, /prefers-color-scheme: dark/);
		assert.ok(!SYSTEM_MODE_SCRIPT.includes("localStorage"), "settings live on disk, not in storage");
	});
});

describe("variant palettes", () => {
	it("dark default reproduces today's hand-picked palette exactly", () => {
		const p = variantPalette("dark", null);
		assert.equal(p["--background"], "#141414");
		assert.equal(p["--card"], "#1c1c1c");
		assert.equal(p["--accent"], "#2a2a2a");
		assert.equal(p["--border"], "#434343");
		assert.equal(p["--muted-foreground"], "#8d8d8d");
		assert.equal(p["--lh-line-strong"], "#ffffff");
	});

	it("light default: paper page, white raised surfaces, darker edges", () => {
		const p = variantPalette("light", null);
		assert.equal(p["--background"], MODE_DEFAULT_BACKGROUND.light);
		assert.equal(p["--card"], "#ffffff");
		assert.equal(p["--accent"], "#e8e8e6");
		assert.equal(p["--border"], "#d4d4d2");
		assert.equal(p["--foreground"], "#1a1a1a");
		assert.equal(p["--primary-foreground"], "#f5f5f3");
		assert.equal(p["--lh-line-strong"], "#1a1a1a");
	});

	it("a custom light background derives along the light curve, clamped at 0", () => {
		const p = variantPalette("light", "#101010");
		assert.equal(p["--accent"], "#030303");
		assert.equal(p["--border"], "#000000");
	});
});

/** The `--token: value;` declarations of the first rule whose selector is
 *  exactly `selector`, with same-block var() references resolved. */
function cssBlock(css: string, selector: string): { at: number; tokens: Record<string, string> } {
	const at = css.indexOf(`\n${selector} {`);
	assert.ok(at >= 0, `no "${selector}" block in globals.css`);
	const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
	const tokens: Record<string, string> = {};
	for (const [, name, value] of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) tokens[name!] = value!.trim();
	for (const [k, v] of Object.entries(tokens)) {
		const ref = /^var\((--[\w-]+)\)$/.exec(v)?.[1];
		if (ref && tokens[ref]) tokens[k] = tokens[ref];
	}
	return { at, tokens };
}

describe("globals.css defaults = variantPalette(…, null)", () => {
	const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	const blocks: Record<RenderedMode, ReturnType<typeof cssBlock>> = {
		dark: cssBlock(css, ":root,\n.dark"),
		light: cssBlock(css, ".light"),
	};

	for (const mode of ["dark", "light"] as const) {
		it(`${mode}: every palette token matches (change one, change both)`, () => {
			for (const [token, value] of Object.entries(variantPalette(mode, null))) {
				assert.equal(blocks[mode].tokens[token], value, `${mode} ${token}`);
			}
		});
	}

	it(".light comes after the dark block — equal specificity, so order decides", () => {
		assert.ok(blocks.light.at > blocks.dark.at);
	});
});

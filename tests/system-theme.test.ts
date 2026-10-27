/**
 * The Omarchy theme (2026-10-26): the theme file's sanitizer, its CSS
 * variables, the appearance mapping that prefers it over the background
 * derivation, the settings parser's theme field, and the server's file
 * read + directory watch that drives the live retint.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";
import { subscribe } from "../src/core/events.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { SYSTEM_THEME_COLOR_VARS, sanitizeSystemTheme, systemThemeVars } from "../src/core/system-theme.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { readSystemTheme, watchSystemTheme } from "../src/server/system-theme.ts";

function themeFile(mode: "dark" | "light" = "dark") {
	const colors: Record<string, string> = {};
	for (const key of Object.keys(SYSTEM_THEME_COLOR_VARS)) colors[key] = "#2f3138";
	colors.foreground = "#c7c6c1";
	return { name: "Omarchy", mode, colors };
}

describe("sanitizeSystemTheme", () => {
	it("accepts a complete file", () => {
		const theme = sanitizeSystemTheme(themeFile("light"));
		assert.equal(theme?.mode, "light");
		assert.equal(theme?.name, "Omarchy");
		assert.equal(theme?.colors.foreground, "#c7c6c1");
	});

	it("rejects a file missing a token or carrying a bad color", () => {
		const missing = themeFile();
		delete (missing.colors as Record<string, string>).ring;
		assert.equal(sanitizeSystemTheme(missing), null);
		const bad = themeFile();
		bad.colors.border = "{{ muted }}";
		assert.equal(sanitizeSystemTheme(bad), null);
	});

	it("rejects an unknown mode and non-objects", () => {
		assert.equal(sanitizeSystemTheme({ ...themeFile(), mode: "auto" }), null);
		assert.equal(sanitizeSystemTheme(null), null);
		assert.equal(sanitizeSystemTheme([]), null);
	});
});

describe("systemThemeVars", () => {
	it("sets every palette variable and the color scheme", () => {
		const vars = systemThemeVars(sanitizeSystemTheme(themeFile("light"))!);
		assert.equal(vars["color-scheme"], "light");
		assert.equal(vars["--foreground"], "#c7c6c1");
		for (const cssVar of Object.values(SYSTEM_THEME_COLOR_VARS)) assert.ok(cssVar in vars, cssVar);
	});
});

describe("appearanceVars with the Omarchy theme", () => {
	const theme = sanitizeSystemTheme(themeFile())!;

	it("uses the theme file over the background derivation when selected", () => {
		const vars = appearanceVars(resolveAppearance({ theme: "omarchy", background: "#000000" }), theme);
		assert.equal(vars["--background"], "#2f3138");
		assert.equal(vars["--foreground"], "#c7c6c1");
	});

	it("keeps the app palette when the default theme is selected", () => {
		const vars = appearanceVars(resolveAppearance({ background: "#000000" }), theme);
		assert.equal(vars["--background"], "#000000");
		assert.equal(vars["--foreground"], undefined);
	});

	it("falls back to the app palette when the file is missing", () => {
		const vars = appearanceVars(resolveAppearance({ theme: "omarchy" }), null);
		assert.equal(vars["--background"], undefined);
	});

	it("still applies emphasis overrides on top of the theme", () => {
		const vars = appearanceVars(
			resolveAppearance({ theme: "omarchy", mdRendering: { boldColor: "#ff0000" } }),
			theme,
		);
		assert.equal(vars["--lh-ink-strong"], "#ff0000");
	});
});

describe("appearance.theme in settings", () => {
	it("the PUT parser accepts the two themes and rejects others", () => {
		assert.deepEqual(parseAppearanceSettingsBody({ theme: "omarchy" }), { ok: true, settings: { theme: "omarchy" } });
		assert.equal(parseAppearanceSettingsBody({ theme: "solarized" }).ok, false);
	});

	it("the record sanitizer drops an unknown theme", () => {
		assert.equal(sanitizeUserSettings({ appearance: { theme: "solarized" } })?.appearance?.theme, undefined);
		assert.equal(sanitizeUserSettings({ appearance: { theme: "omarchy" } })?.appearance?.theme, "omarchy");
	});
});

describe("the server's theme file", () => {
	it("reads null for a missing or partial file, the theme for a complete one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-theme-"));
		const file = path.join(dir, "omarchy.json");
		assert.equal(readSystemTheme(file), null);
		fs.writeFileSync(file, "{not json");
		assert.equal(readSystemTheme(file), null);
		fs.writeFileSync(file, JSON.stringify(themeFile()));
		assert.equal(readSystemTheme(file)?.colors.foreground, "#c7c6c1");
		fs.rmSync(dir, { recursive: true });
	});

	it("emits theme-changed when the hook atomically replaces the file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-theme-"));
		const file = path.join(dir, "omarchy.json");
		assert.equal(watchSystemTheme(file), true);
		const changed = new Promise<void>((resolve) => {
			const off = subscribe((event) => {
				if (event.type !== "theme-changed") return;
				off();
				resolve();
			});
		});
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(themeFile("light")));
		fs.renameSync(tmp, file);
		await changed;
		assert.equal(readSystemTheme(file)?.mode, "light");
		fs.rmSync(dir, { recursive: true });
	});
});

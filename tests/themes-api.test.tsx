/**
 * The theme wave end to end over the real route handlers and the real
 * disk adapters (framework-free Request/Response, the prompt-overrides
 * precedent): picking a preset, importing and removing a custom theme,
 * and exporting. This file OWNS its temp LH_DATA_DIR (set before any
 * config-loading import — config.ts reads it at module load).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-themes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { THEMES_DIR } = await import("../config.ts");
const { PUT: putSection } = await import("../app/api/settings/[section]/route.ts");
const { GET: getThemes, POST: postTheme } = await import("../app/api/themes/route.ts");
const { DELETE: deleteTheme } = await import("../app/api/themes/[id]/route.ts");
const { readSettingsRecord, writeSettingsRecord, readThemeBoot, themeStore } = await import("../src/server/index.ts");
const { BUILTIN_THEMES, exportThemeFile, themeVars, effectiveColors } = await import("../src/core/index.ts");
const { AppearanceProvider, appearanceVars, resolveAppearance } = await import("../components/settings/appearance.tsx");
const { AppearanceSection } = await import("../components/settings/appearance-section.tsx");
type Theme = import("../src/core/index.ts").Theme;
type AppearanceSettings = import("../src/core/index.ts").AppearanceSettings;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => {
	fs.rmSync(THEMES_DIR, { recursive: true, force: true });
	writeSettingsRecord({ version: 1 });
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (section: string, body: unknown) =>
	putSection(new Request(`http://x/api/settings/${section}`, { ...json(body), method: "PUT" }), { params: Promise.resolve({ section }) });
const post = (body: unknown) => postTheme(new Request("http://x/api/themes", json(body)));
const del = (id: string) => deleteTheme(new Request(`http://x/api/themes/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
const list = async () => ((await (await getThemes()).json()) as { themes: Theme[] }).themes;

/** The Settings section exactly as the app mounts it after a reload. */
function renderSection(): string {
	const { appearance, theme } = readThemeBoot();
	return renderToStaticMarkup(
		<InteractionLayersProvider>
			<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
				<AppearanceSection appearance={appearance} onSectionChange={() => true} />
			</AppearanceProvider>
		</InteractionLayersProvider>,
	);
}
const pressed = (html: string, id: string) => {
	const i = html.indexOf(`data-testid="theme-card-${id}"`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i)).includes('aria-pressed="true"');
};

const mocha = BUILTIN_THEMES.find((t) => t.id === "catppuccin-mocha")!;
const latte = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte")!;
const ayu = {
	name: "My Ayu",
	mode: "dark",
	colors: {
		background: "#0f1419", surface: "#14191f", border: "#253340", text: "#e6e1cf", textMuted: "#5c6773",
		accent: "#ffb454", bold: "#ffb454", italic: "#95e6cb", code: "#e6b673",
		error: "#f07178", success: "#aad94c", warning: "#ffb454",
	},
};

describe("picking a preset recolors the app and keeps my overrides", () => {
	it("the background override survives the switch and paints over Latte", async () => {
		writeSettingsRecord({ version: 1, appearance: { background: "#101010" } });
		// The theme grid composes the whole section with the new id.
		const res = await put("appearance", { ...readSettingsRecord()!.appearance, theme: "catppuccin-latte" });
		assert.equal(res.status, 200);
		const stored = readSettingsRecord()!.appearance!;
		assert.equal(stored.theme, "catppuccin-latte");
		assert.equal(stored.background, "#101010");

		const html = renderSection();
		assert.ok(pressed(html, "catppuccin-latte"));
		assert.ok(!pressed(html, "default"));

		const { theme } = readThemeBoot();
		assert.equal(theme.mode, "light");
		const vars = appearanceVars(resolveAppearance(stored), theme);
		assert.equal(vars["--background"], "#101010");
		assert.equal(vars["--card"], latte.colors.surface);
		assert.equal(vars["--foreground"], latte.colors.text);
		assert.equal(vars["--lh-success"], latte.colors.success);
	});

	for (const missing of ["deleted", "malformed"]) {
		it(`an active ${missing} custom theme heals to Default while other appearance edits save`, async () => {
			await post(ayu);
			await put("appearance", { theme: "my-ayu", background: "#123456", codeLigatures: true });
			if (missing === "deleted") fs.unlinkSync(path.join(THEMES_DIR, "my-ayu.json"));
			else fs.writeFileSync(path.join(THEMES_DIR, "my-ayu.json"), "{truncated");
			assert.equal(readThemeBoot().theme.id, "default");
			const res = await put("appearance", { ...readSettingsRecord()!.appearance, proseFontSize: 20 });
			assert.equal(res.status, 200);
			assert.deepEqual(readSettingsRecord()!.appearance, {
				theme: "default", background: "#123456", codeLigatures: true, proseFontSize: 20,
			});
			assert.equal((await put("appearance", { theme: "another-missing" })).status, 400, "new unknown selections still fail");
		});
	}

	it("an unknown theme id is refused and the record is untouched", async () => {
		const res = await put("appearance", { theme: "no-such-theme" });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /unknown theme "no-such-theme"/);
		assert.equal(readSettingsRecord()!.appearance, undefined);
	});
});

describe("importing a theme file makes it a selectable card; a bad file leaves no trace", () => {
	it("server first paint reads only the selected custom file, not the whole catalog", async t => {
		await post(ayu);
		await put("appearance", { theme: "my-ayu" });
		t.mock.method(themeStore, "listThemes", () => { throw new Error("Must not enumerate for first paint"); });
		assert.equal(readThemeBoot().theme.id, "my-ayu");
	});

	it("storage failure cannot return import success, and invalid store ids fail loudly", async t => {
		for (const id of ["default", "../escape", "a-", "a".repeat(65)]) {
			assert.throws(() => themeStore.writeTheme(id, mocha), /Invalid custom theme id/);
		}
		t.mock.method(themeStore, "writeTheme", () => { throw new Error("Synthetic disk failure"); });
		await assert.rejects(post(ayu), /Synthetic disk failure/);
		assert.equal(fs.existsSync(THEMES_DIR), false);
	});
	it("valid file → 201, on disk, listed after the presets, selectable", async () => {
		const res = await post(ayu);
		assert.equal(res.status, 201);
		const { theme } = (await res.json()) as { theme: Theme };
		assert.equal(theme.id, "my-ayu");
		assert.ok(fs.existsSync(path.join(THEMES_DIR, "my-ayu.json")));
		const themes = await list();
		assert.deepEqual(themes.map((t) => t.id), [...BUILTIN_THEMES.map((t) => t.id), "my-ayu"]);
		assert.equal((await put("appearance", { theme: "my-ayu" })).status, 200);
		assert.ok(pressed(renderSection(), "my-ayu"));
	});

	it("long names, truncation at a separator, and collisions always save valid selectable ids", async () => {
		for (const name of ["a".repeat(100), `${"b".repeat(63)} c`, "Default"]) {
			for (let n = 0; n < 3; n++) {
				const res = await post({ ...ayu, name });
				assert.equal(res.status, 201);
				const { theme } = await res.json() as { theme: Theme };
				assert.ok(theme.id.length <= 64);
				assert.match(theme.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
				assert.ok(fs.existsSync(path.join(THEMES_DIR, `${theme.id}.json`)));
				assert.equal((await put("appearance", { theme: theme.id })).status, 200);
				assert.equal(readThemeBoot().theme.id, theme.id);
			}
		}
	});

	it("a file missing colors.error → 400 naming it, nothing written", async () => {
		const { error: _drop, ...colors } = ayu.colors;
		const res = await post({ ...ayu, colors });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /colors\.error/);
		assert.equal(fs.existsSync(THEMES_DIR) && fs.readdirSync(THEMES_DIR).length > 0, false);
		assert.deepEqual((await list()).map((t) => t.id), BUILTIN_THEMES.map((t) => t.id));
	});

	it("a name taken by a preset or an earlier import gets a numbered id", async () => {
		const first = (await (await post({ ...ayu, name: "Default" })).json()) as { theme: Theme };
		assert.equal(first.theme.id, "default-2");
		const second = (await (await post({ ...ayu, name: "Default" })).json()) as { theme: Theme };
		assert.equal(second.theme.id, "default-3");
	});
});

describe("removing the active custom theme falls back to Default without losing anything else", () => {
	it("file gone, record on default, the warning override intact", async () => {
		await post(ayu);
		await put("appearance", { theme: "my-ayu", colors: { warning: "#123456" } });
		const res = await del("my-ayu");
		assert.equal(res.status, 200);
		assert.ok(!fs.existsSync(path.join(THEMES_DIR, "my-ayu.json")));
		const stored = readSettingsRecord()!.appearance!;
		assert.equal(stored.theme, "default");
		assert.deepEqual(stored.colors, { warning: "#123456" });
		assert.ok(pressed(renderSection(), "default"));
	});

	it("presets cannot be removed; unknown ids are a 404", async () => {
		assert.equal((await del("catppuccin-mocha")).status, 400);
		assert.equal((await del("nope")).status, 404);
	});
});

describe("export reflects what I see", () => {
	it("Mocha + a warning override exports Mocha's 12 with that warning, and re-imports to the same vars", async () => {
		const appearance: AppearanceSettings = { theme: "catppuccin-mocha", colors: { warning: "#fab387" } };
		await put("appearance", appearance);
		const exported = exportThemeFile(readThemeBoot().theme, readSettingsRecord()!.appearance);
		assert.deepEqual(exported, { name: "Catppuccin Mocha", mode: "dark", colors: { ...mocha.colors, warning: "#fab387" } });

		const res = await post(exported);
		assert.equal(res.status, 201);
		const { theme } = (await res.json()) as { theme: Theme };
		assert.equal(theme.id, "catppuccin-mocha-2", "the preset's id stays reserved");
		assert.deepEqual(themeVars(effectiveColors(theme, undefined), theme.mode), readThemeBoot().vars);
	});
});

import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { PluginViewScreen } from "../components/plugin-view.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";
import { parseHTML } from "linkedom";

describe("plugin view host shell", () => {
	it("uses the shared session-sized title, drag/WCO header and sidebar reopen even while loading", () => {
		const html = renderToStaticMarkup(<PluginViewScreen pluginId="fixture" viewId="overview" />);
		assert.ok(html.includes("lh-wco-gutter"));
		assert.ok(html.includes("lh-drag"));
		assert.ok(html.includes('aria-label="Open sidebar"'));
		assert.ok(html.includes("font-title text-3xl tracking-tight"));
		assert.ok(html.includes('aria-label="Plugin settings"'));
		assert.ok(html.includes("Loading plugin…"));
		assert.ok(!html.includes("text-2xl"));
	});

	it("bounds scrolling below the top bar and keeps surface overlays outside that viewport", () => {
		const { document } = parseHTML(renderToStaticMarkup(<PluginViewScreen pluginId="fixture" viewId="overview" />));
		const viewport = document.querySelector("[data-plugin-view-scroll]"); assert.ok(viewport);
		assert.equal(viewport.className, "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto");
		assert.ok(viewport.querySelector('[role="status"]'));
		assert.equal(viewport.querySelector("header"), null);
		const region = document.querySelector("[data-session-surface-region]"); assert.ok(region);
		assert.equal(region.parentElement, viewport.parentElement);
		assert.equal(viewport.contains(region), false);
		const shell = document.querySelector("header")?.parentElement; assert.ok(shell);
		assert.ok(shell.classList.contains("h-dvh"));
		assert.ok(!shell.classList.contains("overflow-y-auto"), "the full page is not the scroll owner");
	});

	it("mounts view content, limits top-bar actions to own view and gear opens its settings page", async () => {
		let settingsMounts = 0;
		const f = await mountPluginChrome({ activate(ctx) {
			ctx.registerView({ id: "overview", name: "Fixture overview", mount(container) { container.textContent = "View content"; } });
			ctx.registerAction({ id: "own", name: "Own view action", run() {} });
			ctx.registerAction({ id: "other", name: "Other view action", run() {} });
			ctx.placeAction({ id: "own-top", actionId: "own", location: "top-bar", views: ["overview"] });
			ctx.placeAction({ id: "other-top", actionId: "other", location: "top-bar", views: ["elsewhere"] });
			ctx.registerSettings(container => { settingsMounts++; container.textContent = "Fixture settings content"; });
		} }, <SettingsDialogProvider><PluginViewScreen pluginId="fixture" viewId="overview" /></SettingsDialogProvider>);
		try {
			assert.equal(f.document.querySelector("h1")?.textContent, "Fixture overview");
			assert.ok(f.document.body.textContent?.includes("View content"));
			assert.ok(f.document.querySelector('[data-plugin-action="fixture/own-top"]'));
			assert.equal(f.document.querySelector('[data-plugin-action="fixture/other-top"]'), null);
			assert.equal(settingsMounts, 0);
			await f.click(f.document.querySelector<HTMLButtonElement>('[aria-label="Plugin settings"]')!);
			assert.equal(settingsMounts, 1);
			assert.ok(f.document.body.textContent?.includes("Fixture settings content"));
			assert.equal(f.document.querySelector('[data-testid="settings-nav-plugin:fixture"]')?.getAttribute("aria-current"), "true");
		} finally { await f.close(); }
	});

	it("unavailable views retain the host shell and home escape", async () => {
		const f = await mountPluginChrome({ activate() {} }, <PluginViewScreen pluginId="fixture" viewId="missing" />);
		try {
			assert.ok(f.document.body.textContent?.includes("This plugin view is not available."));
			assert.equal(f.document.querySelector('a[href="/"]')?.textContent, "Back to home");
			assert.ok(f.document.querySelector('header.lh-wco-gutter [aria-label="Plugin settings"]'));
		} finally { await f.close(); }
	});
});

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { createPluginWindowOwner, PluginsProvider } from "../components/plugins.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import type { PluginFrontendModule, PluginInfo } from "../src/core/index.ts";

function info(id: string, enabled = true): PluginInfo {
	return { id, enabled, status: enabled ? "active" : "disabled", revision: "one", manifest: {
		apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.3.7",
		...(id === "backend" ? { backend: "backend.cjs" } : { main: "main.js" }),
	} };
}

it("dedicated plugin settings pages cover schema/custom/empty/loading/error, deep links, and removal", async () => {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const keys = ["window", "self", "document", "HTMLElement", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const coreRequests: string[] = [];
	let rejectCore!: (error: Error) => void;
	const coreSettings = new Promise<Response>((_resolve, reject) => { rejectCore = reject; });
	Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		fetch: (url: string) => { coreRequests.push(String(url)); return coreSettings; }, IS_REACT_ACT_ENVIRONMENT: true });
	let customMounts = 0, customCleanups = 0;
	const changes: boolean[] = [];
	const loading = new Promise<void>(() => {});
	const modules: Record<string, PluginFrontendModule> = {
		schema: { activate(ctx) { ctx.registerSettings({ rows: [
			{ key: "feature", label: "Feature enabled", type: "toggle", value: false, async onChange(value) { changes.push(value); } },
			{ key: "validated", label: "Validated preference", type: "toggle", value: false, validate: () => "Preference is invalid", onChange() { assert.fail("invalid values must not persist"); } },
			{ key: "failing", label: "Failing preference", type: "toggle", value: false, async onChange() { throw new Error("Plugin save failed"); } },
		] }); } },
		custom: { activate(ctx) { ctx.registerSettings(container => { customMounts++; container.textContent = "Custom preferences"; return () => { customCleanups++; }; }); } },
		loading: { activate: () => loading },
		broken: { activate() { throw new Error("Fixture activation failed"); } },
	};
	const owner = createPluginWindowOwner({
		fetch: async () => Response.json({ plugins: [info("schema"), info("custom"), info("backend"), info("loading"), info("broken"), info("disabled", false)], directory: "/fixtures/plugins" }),
		importModule: async url => modules[decodeURIComponent(url.split("/")[3]!)]!,
		pathname: () => "/", navigate() {},
	});
	window.__lhPluginWindow = owner;
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	const shell = (children: React.ReactNode) => <AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider>;
	const root = createRoot(document.querySelector("#root")!);
	const click = async (selector: string) => {
		const element = document.querySelector(selector);
		assert.ok(element, selector);
		await act(async () => { element.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
	};
	const page = () => document.querySelector('[data-testid="settings-content"]');
	try {
		await act(async () => { root.render(shell(<SettingsDialogBody initialSection="plugin:schema" onClose={() => {}} />)); });
		assert.ok(page()?.textContent?.includes("Feature enabled"), "deep link renders while core settings are pending");
		const nav = document.querySelector('[data-testid="settings-nav"]')!;
		assert.deepEqual([...nav.querySelectorAll("button")].map(button => button.textContent), ["Providers", "Agent", "Appearance", "Graph", "Keyboard", "General", "Plugins", "Plugin schema", "Plugin custom", "Plugin backend", "Plugin loading", "Plugin broken"]);
		assert.equal(nav.querySelectorAll("hr").length, 2);
		assert.ok(nav.className.includes("overflow-y-auto"));
		await click('[data-testid="section-plugin-schema"] [role="switch"]');
		assert.deepEqual(changes, [true]);
		await click('[data-plugin-setting="validated"] [role="switch"]');
		assert.ok(page()?.querySelector('[data-plugin-setting="validated"] [role="alert"]')?.textContent?.includes("Preference is invalid"));
		await click('[data-plugin-setting="failing"] [role="switch"]');
		assert.ok(page()?.querySelector('[data-plugin-setting="failing"] [role="alert"]')?.textContent?.includes("Plugin save failed"));
		assert.deepEqual(coreRequests, ["/api/settings"], "schema changes do not write core settings");
		await act(async () => { rejectCore(new Error("Core settings unavailable")); });
		assert.ok(page()?.textContent?.includes("Feature enabled"), "core fetch error does not gate plugin page");
		await click('[data-testid="settings-nav-plugin:custom"]');
		assert.equal(customMounts, 1); assert.ok(page()?.textContent?.includes("Custom preferences"));
		await click('[data-testid="settings-nav-plugin:backend"]');
		assert.equal(customCleanups, 1, "switching settings page tears down custom mount");
		assert.ok(page()?.textContent?.includes("No settings available."));
		await click('[data-testid="settings-nav-plugin:loading"]');
		assert.ok(page()?.textContent?.includes("Loading plugin settings…"));
		await click('[data-testid="settings-nav-plugin:broken"]');
		assert.ok(page()?.querySelector('[role="alert"]')?.textContent?.includes("Fixture activation failed"));
		await click('[data-testid="settings-nav-plugin:custom"]');
		await act(async () => { owner.manager.reconcile([info("schema"), info("backend")]); });
		assert.equal(customCleanups, 2);
		assert.ok(page()?.querySelector('[data-testid="section-plugins"]'), "uninstall active plugin returns to management");
		assert.equal(document.querySelector('[data-testid="settings-nav-plugin:custom"]'), null);
		await act(async () => { root.render(shell(<SettingsDialogBody initialSection="plugin:not-installed" onClose={() => {}} />)); });
		assert.ok(page()?.querySelector('[data-testid="section-plugins"]'), "missing deep link falls back to management");

		// Backend app.openSettings uses a browser event bridge into this provider.
		await act(async () => { root.render(shell(<SettingsDialogProvider><p>App</p></SettingsDialogProvider>)); });
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:open-plugin-settings", { detail: { id: "schema" } })); });
		assert.equal(document.querySelector('[role="dialog"]'), null, "non-string event details are ignored");
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:open-plugin-settings", { detail: "schema" })); });
		assert.ok(document.querySelector('[data-testid="section-plugin-schema"]'));
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:open-plugin-settings", { detail: "backend" })); });
		assert.ok(document.querySelector('[data-testid="section-plugin-backend"]'), "an open dialog follows the next plugin deep link");
		await click('[data-testid="settings-nav-plugin:schema"]');
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:open-plugin-settings", { detail: "backend" })); });
		assert.ok(document.querySelector('[data-testid="section-plugin-backend"]'), "repeating the same open request retargets after manual navigation");
	} finally {
		await act(async () => { root.unmount(); });
		for (const key of keys) {
			const descriptor = saved.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});

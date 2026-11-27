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
import type { CommunityOffer, PluginFrontendModule, PluginInfo } from "../src/core/index.ts";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";

function info(id: string, enabled = true): PluginInfo {
	return { id, origin: id === "schema" ? "core" : "community", enabled, status: enabled ? "active" : "disabled", revision: "one", manifest: {
		apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.3.7",
		...(id === "backend" ? { backend: "backend.cjs" } : { main: "main.js" }),
	} };
}

it("dedicated plugin settings pages cover schema/custom/empty/loading/error, deep links, and removal", async () => {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const keys = ["window", "self", "document", "HTMLElement", "Element", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const coreRequests: string[] = [];
	let rejectCore!: (error: Error) => void;
	const coreSettings = new Promise<Response>((_resolve, reject) => { rejectCore = reject; });
	const listing = { id: "synthetic", name: "Synthetic", author: "Fixture", description: "Test listing", repository: "fixture/synthetic", releases: [] };
	const offer: CommunityOffer = { listing, action: "Install", release: { version: "1.0.0", apiVersion: 1, minAppVersion: "0.7.0", publishedAt: "2026-10-01T00:00:00Z", tag: "v1.0.0", asset: "fixture.zip", sha256: "a".repeat(64) } };
	let communityEnabled = true, catalogReads = 0;
	let replyToInstall!: (response: Response) => void;
	const pendingInstall = new Promise<Response>(resolve => { replyToInstall = resolve; });
	Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
		fetch: async (url: string) => {
			if (url === "/api/plugin-catalog") { catalogReads++; return Response.json({ offers: [offer] }); }
			coreRequests.push(String(url)); return coreSettings;
		}, IS_REACT_ACT_ENVIRONMENT: true });
	const restoreModalDom = installModalDom(dom);
	const getSelection = Object.getOwnPropertyDescriptor(dom.window, "getSelection");
	Object.defineProperty(dom.window, "getSelection", { configurable: true, value: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }) });
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
		fetch: async (url, init) => {
			if (url === "/api/plugin-catalog/synthetic") {
				assert.equal(init?.method, "POST"); assert.equal(init?.signal, undefined);
				return pendingInstall;
			}
			if (url === "/api/plugins" && init?.method === "PUT") {
				communityEnabled = JSON.parse(String(init.body)).enabled;
				return Response.json({ communityEnabled });
			}
			return Response.json({ plugins: [info("schema"), info("custom"), info("backend"), info("loading"), info("broken"), info("disabled", false)], directory: "/fixtures/plugins", communityEnabled, conflicts: [{ id: "schema", error: "Community schema skipped: reserved Core plugin ID" }] });
		},
		importModule: async url => modules[decodeURIComponent(url.split("/")[3]!)]!,
		pathname: () => "/", navigate() {},
	});
	window.__lhPluginWindow = owner;
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	const shell = (children: React.ReactNode) => <InteractionLayersProvider><AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider></InteractionLayersProvider>;
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
		assert.deepEqual([...nav.querySelectorAll("button")].map(button => button.textContent), ["Providers", "Agent", "Appearance", "Graph", "Keyboard", "General", "Core plugins", "Community plugins", "Plugin schema", "Plugin custom", "Plugin backend", "Plugin loading", "Plugin broken"]);
		assert.equal(nav.querySelectorAll("svg").length, 8, "only built-in navigation entries receive icons");
		for (const button of nav.querySelectorAll("button")) {
			if (button.getAttribute("data-testid")?.startsWith("settings-nav-plugin:")) {
				assert.equal(button.querySelector("svg"), null, "individual plugin entries remain unchanged");
			}
		}
		assert.equal(nav.querySelectorAll("hr").length, 2);
		assert.ok(nav.className.includes("overflow-y-auto"));
		await click('[data-testid="settings-nav-core-plugins"]');
		const corePage = page()!.textContent!;
		assert.ok(corePage.includes("Plugin schema"));
		for (const absent of ["Plugin custom", "trusted local code", "Refresh plugins", "/fixtures/plugins", "1.0.0", "reserved Core plugin ID"]) assert.ok(!corePage.includes(absent), absent);
		await click('[data-testid="settings-nav-plugins"]');
		assert.ok(page()!.textContent!.includes("Plugin custom")); assert.ok(!page()!.querySelector('[data-testid="plugin-schema"]'));
		assert.ok(page()!.textContent!.includes("reserved Core plugin ID")); assert.ok(page()!.textContent!.includes("1.0.0"));
		const browse = '[data-testid="section-plugins"] button[aria-haspopup="dialog"]';
		const dialog = '[data-testid="community-plugin-browser"]';
		const search = `${dialog} input[type="search"]`;
		const install = `${dialog} [aria-label="Install Synthetic"]`;
		const gate = '[aria-label="Allow community plugins"]';
		const key = async (name: string, shiftKey = false) => {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: name, shiftKey });
			await act(async () => { document.activeElement?.dispatchEvent(event); });
		};
		(document.querySelector(browse) as HTMLElement).focus();
		await click(browse);
		assert.equal(document.activeElement, document.querySelector(search));
		await key("Tab"); assert.equal(document.activeElement, document.querySelector(install));
		await key("Tab"); assert.equal(document.activeElement?.textContent, "Source");
		await key("Tab", true); assert.equal(document.activeElement, document.querySelector(install));
		await click(install);
		assert.match(document.querySelector(`${dialog} [role="status"]`)!.textContent!, /Installing Synthetic/);
		assert.equal(document.querySelector(`${dialog} [aria-label="Close Browse"]`)?.hasAttribute("disabled"), false);
		await click(`${dialog} [aria-label="Close Browse"]`);
		await new Promise(resolve => setTimeout(resolve, 5));
		assert.equal(document.activeElement, document.querySelector(browse));
		assert.match(page()!.textContent!, /Installing Synthetic/);
		await click(gate);
		assert.equal(communityEnabled, false); assert.match(page()!.textContent!, /Installing Synthetic/);
		await act(async () => { replyToInstall(Response.json({ error: "Community plugins are off." }, { status: 409 })); });
		assert.match(page()!.textContent!, /Could not install Synthetic: Community plugins are off/);
		const optIn = '[data-testid="community-opt-in-dialog"]';
		assert.equal(document.querySelector(optIn), null);
		await click(gate);
		assert.equal(communityEnabled, false, "opt-in waits for confirmation");
		assert.match(document.querySelector(optIn)!.textContent!, /unreviewed third-party code.*resumes any plugins you previously enabled/);
		await click('[data-testid="community-opt-in-cancel"]');
		assert.equal(document.querySelector(optIn), null); assert.equal(communityEnabled, false, "Cancel leaves community plugins off");
		await click(gate);
		await click('[data-testid="community-opt-in-confirm"]');
		assert.equal(communityEnabled, true); assert.equal(document.querySelector(optIn), null);
		assert.match(page()!.textContent!, /unreviewed third-party code/, "the warning stays visible while on");
		assert.doesNotMatch(page()!.textContent!, /resumes any plugins you previously enabled/);
		await click(browse);
		assert.equal(catalogReads, 2);
		communityEnabled = false;
		await act(async () => { await owner.manager.reload(); });
		assert.equal(document.querySelector(dialog), null);
		communityEnabled = true;
		await act(async () => { await owner.manager.reload(); });
		assert.ok(document.querySelector(browse)); assert.equal(document.querySelector(dialog), null); assert.equal(catalogReads, 2);
		await click('[data-testid="settings-nav-plugin:schema"]');
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

		await act(async () => { root.render(shell(<SettingsDialogBody initialSection="plugin:schema" onClose={() => {}} />)); });
		await act(async () => { owner.manager.reconcile([info("schema", false), info("backend")]); });
		assert.ok(page()?.querySelector('[data-testid="section-core-plugins"]'), "disabled core settings return to Core management");
		await act(async () => { owner.manager.reconcile([info("schema"), info("backend")]); });

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
		// Let FocusScope finish its unmount event before restoring globals.
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModalDom();
		if (getSelection) Object.defineProperty(dom.window, "getSelection", getSelection); else Reflect.deleteProperty(dom.window, "getSelection");
		for (const key of keys) {
			const descriptor = saved.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
});

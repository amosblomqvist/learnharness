import React, { act, type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { parseHTML } from "linkedom";
import { PluginsProvider, createPluginWindowOwner } from "../components/plugins.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { ToolPartRenderer } from "../components/plugin-renderers.tsx";
import { PluginWorkerCard } from "../components/artifacts/plugin-worker-card.tsx";
import type { PluginBackgroundResult, PluginInfo, PluginToolRenderProps } from "../src/core/index.ts";

it("registered renderers override native plugin dispatch/result bodies; disable restores host defaults", async () => {
	const dom = parseHTML("<html><head></head><body><div id='test-root'></div></body></html>");
	const keys = ["window", "self", "document", "HTMLElement", "Element", "Node", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true });
	const info: PluginInfo = { id: "presentation-proof", enabled: true, status: "active", revision: "fixture-1", manifest: { apiVersion: 1, id: "presentation-proof", name: "Presentation proof", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js" } };
	const seen: PluginToolRenderProps[] = [];
	// No network, plugin files, or provider calls: the real manager imports an in-memory fixture.
	const owner = createPluginWindowOwner({
		reservedCodeBlockLanguages: [], reservedToolNames: [], pathname: () => "/", navigate() {},
		fetch: async () => Response.json({ plugins: [info], directory: "/fixture/plugins" }),
		importModule: async () => ({ activate(ctx) {
			ctx.registerToolRenderer({ toolName: "check_sources", mount(container, props) { seen.push(props); container.textContent = props.background ? "Custom result body" : "Custom dispatch body"; } });
			for (const backgroundPresentation of ["card", "plain"] as const) ctx.registerToolRenderer({
				toolName: `check_sources_${backgroundPresentation}`, backgroundPresentation,
				mount(container) { container.innerHTML = '<svg data-testid="custom-rich-body" aria-label="Custom figure"></svg>'; },
			});
		} }),
	});
	window.__lhPluginWindow = owner;
	const root = createRoot(document.querySelector("#test-root")!);
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	const render = async (children: ReactNode) => { await act(async () => { root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/"><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></PathnameContext.Provider></AppRouterContext.Provider>); }); };
	const ack = { type: "tool-check_sources", toolCallId: "original-call", state: "output-available" as const, input: {}, result: { content: [{ type: "text" as const, text: "Accepted ACK" }], details: { jobId: "plugin-job", dispatched: true }, isError: false } };
	const result: PluginBackgroundResult = { pluginId: "producer-uninstalled", toolName: "check_sources", input: {}, text: "Persisted **result** text", formatError: "Formatter unavailable", outcome: { id: "task-1", status: "succeeded", result: { raw: "Authoritative outcome" } } };
	try {
		await render(<ToolPartRenderer part={ack} />);
		assert.match(document.body.textContent!, /Custom dispatch body/);
		assert.equal(document.querySelector('[data-testid="dispatch-card"]'), null);
		assert.deepEqual(seen[0]!.result, ack.result);
		await render(<PluginWorkerCard result={result} toolCallId="original-call" />);
		assert.match(document.body.textContent!, /Custom result body/);
		const details = document.querySelector('[data-testid="plugin-worker-result"]')!;
		assert.equal(details.hasAttribute("open"), false);
		assert.match(document.querySelector('[data-testid="plugin-worker-header"]')!.textContent!, /check_sources succeeded/);
		assert.match(document.querySelector('[role="alert"]')!.textContent!, /Formatter unavailable/);
		assert.equal(document.querySelector('[data-testid="plugin-worker-fallback"]'), null);
		assert.equal(seen[0]!.signal.aborted, true);
		for (const presentation of ["card", "plain"] as const) {
			await render(<PluginWorkerCard result={{ ...result, toolName: `check_sources_${presentation}` }} toolCallId="original-call" />);
			const surface = document.querySelector(`[data-testid="plugin-worker-result-${presentation}"]`)!;
			assert.ok(surface, `the registered ${presentation} presentation controls the host surface`);
			assert.equal(document.querySelector("details"), null, "elaborate/unframed custom results are not nested inside collapsed results");
			assert.ok(surface.querySelector('[data-testid="custom-rich-body"]'));
			assert.equal(surface.querySelector('[data-testid="plugin-worker-header"]')!.textContent, `check_sources_${presentation} succeeded`);
			assert.equal(surface.className.includes("border"), presentation === "card");
			assert.match(document.querySelector('[role="alert"]')!.textContent!, /Formatter unavailable/);
		}
		await render(<PluginWorkerCard result={result} toolCallId="original-call" />);
		await act(async () => { owner.manager.reconcile([{ ...info, enabled: false, status: "disabled" }]); });
		assert.equal(seen[1]!.signal.aborted, true);
		assert.match(document.querySelector('[data-testid="plugin-worker-fallback"]')!.textContent!, /Persisted result textTask details/);
		assert.match(document.body.textContent!, /Authoritative outcome/);
		assert.equal(document.querySelector("[data-plugin-renderer]"), null);
		await render(<ToolPartRenderer part={ack} />);
		assert.match(document.querySelector('[data-testid="dispatch-card"]')!.textContent!, /Plugin workerDispatched/);
		assert.equal(document.querySelector('[data-testid="tool-call-card"]'), null);
	} finally {
		try { await act(async () => { root.unmount(); }); await owner.manager.dispose(); }
		finally { for (const key of keys) { const descriptor = saved.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
	}
});

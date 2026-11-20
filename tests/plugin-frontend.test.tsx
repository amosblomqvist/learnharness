import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";
import { PluginFrontendManager, pluginAssetUrl, pluginViewPath, type PluginHost } from "../components/plugin-manager.ts";
import { createPluginWindowOwner, importPluginModule, PluginsProvider, PluginWidgets } from "../components/plugins.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { PluginsSection } from "../components/settings/plugins-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { PluginCleanup, PluginFrontendContext, PluginFrontendModule, PluginInfo, ServerEvent } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function info(id = "fixture", overrides: Partial<PluginInfo> = {}): PluginInfo {
	return { id, origin: "community", enabled: true, status: "active", revision: "restart-1", manifest: {
		apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.3.7", main: "main.js",
	}, ...overrides };
}
function fixture(frontend: PluginFrontendModule, overrides: Partial<PluginHost> = {}) {
	const imports: string[] = [], navigations: string[] = [];
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const host: PluginHost = {
		fetch: async (url, init) => {
			requests.push({ url: String(url), init });
			return Response.json(String(url).endsWith("/call") ? { result: { answer: 42 } } : { plugins: [], directory: "/fixture/plugins" });
		},
		importModule: async url => { imports.push(url); return frontend; },
		pathname: () => "/chat/existing", navigate: path => { navigations.push(path); },
		...overrides,
	};
	return { manager: new PluginFrontendManager(host), host, imports, navigations, requests };
}

describe("plugin frontend lifecycle", () => {
	it("disabled packages never import; unchanged enabled packages activate once, not per view", async () => {
		let activations = 0, disposed = 0;
		const f = fixture({ activate(ctx) {
			activations++;
			ctx.registerView({ id: "dashboard", name: "Dashboard", mount() {} });
			ctx.registerAction({ id: "sync", name: "Sync", run() {} });
			return () => { disposed++; };
		} });
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		await tick(); assert.equal(f.imports.length, 0);
		f.manager.reconcile([info()]); await tick();
		f.manager.reconcile([info()]); await tick();
		assert.equal(activations, 1);
		assert.equal(f.manager.getSnapshot().plugins[0]!.views[0]!.name, "Dashboard");
		assert.equal(f.manager.getSnapshot().plugins[0]!.actions[0]!.name, "Sync");
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		assert.equal(disposed, 1);
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.views, []);
		f.manager.reconcile([info()]); await tick();
		assert.equal(activations, 2);
		f.manager.dispose(); assert.equal(disposed, 2);
	});

	it("a revised package aborts and cleans the previous activation and stylesheet", async () => {
		const signals: AbortSignal[] = [], styles: string[] = [];
		let cleanups = 0, styleCleanups = 0;
		const f = fixture({ activate(ctx) { signals.push(ctx.signal); ctx.cleanup(() => { cleanups++; }); } }, {
			style: url => { styles.push(url); return () => { styleCleanups++; }; },
		});
		const first = info(); first.manifest!.styles = "main.css";
		f.manager.reconcile([first]); await tick();
		f.manager.reconcile([{ ...first, revision: "restart 2" }]); await tick();
		assert.equal(signals[0]!.aborted, true); assert.equal(signals[1]!.aborted, false);
		assert.equal(cleanups, 1); assert.equal(styleCleanups, 1);
		assert.match(styles[1]!, /main.css\?revision=restart%202$/);
		f.manager.dispose(); assert.equal(styleCleanups, 2);
	});

	it("disable during an import prevents activate from ever running", async () => {
		const importing = deferred<PluginFrontendModule>();
		let activated = 0;
		const f = fixture({ activate() {} }, { importModule: () => importing.promise });
		f.manager.reconcile([info()]);
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		importing.resolve({ activate() { activated++; } }); await tick();
		assert.equal(activated, 0);
	});

	it("late async activation cannot register into a newer generation and cleans orphan returns", async () => {
		const completion = deferred<void>();
		const contexts: PluginFrontendContext[] = [];
		let orphanCleanups = 0, lateCleanups = 0;
		const f = fixture({ async activate(ctx) {
			contexts.push(ctx);
			if (contexts.length === 1) {
				await completion.promise;
				ctx.registerView({ id: "orphan", name: "Orphan", mount() {} });
				ctx.registerAction({ id: "orphan", name: "Orphan", run() {} });
				ctx.registerSettings(() => {});
				ctx.registerCodeBlock({ language: "orphan", mount() {} });
				ctx.registerToolRenderer({ toolName: "orphan", mount() {} });
				ctx.cleanup(() => { lateCleanups++; });
				return () => { orphanCleanups++; };
			}
			ctx.registerView({ id: "new", name: "New", mount() {} });
		} });
		f.manager.reconcile([info()]); await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		f.manager.reconcile([info()]); await tick();
		completion.resolve(); await tick();
		assert.equal(contexts[0]!.signal.aborted, true);
		assert.equal(orphanCleanups, 1); assert.equal(lateCleanups, 1);
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.views.map(v => v.id), ["new"]);
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.actions, []);
		assert.equal(f.manager.getSnapshot().plugins[0]!.settings, undefined);
		assert.deepEqual(f.manager.getSnapshot().codeBlocks, []);
		assert.deepEqual(f.manager.getSnapshot().toolRenderers, []);
		contexts[0]!.app.openHome(); assert.deepEqual(f.navigations, []);
		f.manager.dispose();
	});

	it("awaits async teardown before reactivation without blocking another package or activating canceled generations", async () => {
		const releaseCleanup = deferred<void>();
		const contexts: PluginFrontendContext[] = [];
		let resource: string | undefined;
		let healthyActivations = 0;
		const f = fixture({ activate(ctx) {
			if (ctx.manifest.id === "healthy") { healthyActivations++; return; }
			contexts.push(ctx); resource = `generation-${contexts.length}`;
			ctx.registerView({ id: "proof", name: "Proof", mount() {} });
			if (contexts.length === 1) ctx.cleanup(async () => { await releaseCleanup.promise; resource = undefined; });
		} });
		f.manager.reconcile([info()]); await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		assert.equal(contexts[0]!.signal.aborted, true);
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.views, []);
		f.manager.reconcile([info(), info("healthy")]); await tick();
		assert.equal(contexts.length, 1); assert.equal(resource, "generation-1");
		assert.equal(healthyActivations, 1, "one unresponsive package cannot block other packages");
		assert.equal(f.manager.getSnapshot().plugins[0]!.phase, "loading");
		// Cancel a replacement WHILE it is waiting for the previous teardown.
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" }), info("healthy")]);
		f.manager.reconcile([info(), info("healthy")]); await tick();
		assert.equal(contexts.length, 1);
		releaseCleanup.resolve(); await tick(); await tick();
		assert.equal(contexts.length, 2, "only the latest waiting generation may activate");
		assert.equal(resource, "generation-2", "old async cleanup cannot clobber replacement resources");
		assert.equal(f.imports.filter(url => url.includes("/fixture/")).length, 2);
		assert.equal(f.manager.getSnapshot().plugins[0]!.phase, "active");
		f.manager.dispose();
	});

	it("waits for an aborted activation's late returned async cleanup before a replacement imports or activates", async () => {
		const finishActivation = deferred<void>(), finishRegisteredCleanup = deferred<void>(), finishReturnedCleanup = deferred<void>();
		const order: string[] = [];
		let activations = 0;
		let oldContext!: PluginFrontendContext;
		const f = fixture({ async activate(ctx) {
			activations++;
			if (activations > 1) { order.push("replacement-active"); return; }
			oldContext = ctx;
			ctx.registerView({ id: "old", name: "Old", mount() {} });
			ctx.cleanup(async () => { order.push("registered-cleanup-start"); await finishRegisteredCleanup.promise; order.push("registered-cleanup-end"); });
			await finishActivation.promise;
			ctx.registerView({ id: "late", name: "Late", mount() {} });
			return async () => { order.push("returned-cleanup-start"); await finishReturnedCleanup.promise; order.push("returned-cleanup-end"); };
		} });
		f.manager.reconcile([info()]); await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		f.manager.reconcile([info()]); await tick();
		assert.equal(oldContext.signal.aborted, true);
		assert.deepEqual(order, ["registered-cleanup-start"]);
		assert.equal(f.imports.length, 1, "replacement import itself must wait for old activation and cleanup");
		finishRegisteredCleanup.resolve(); await tick();
		assert.equal(activations, 1, "known cleanup settling alone is insufficient while activate is in flight");
		finishActivation.resolve(); await tick();
		assert.deepEqual(order, ["registered-cleanup-start", "registered-cleanup-end", "returned-cleanup-start"]);
		assert.equal(activations, 1); assert.equal(f.imports.length, 1);
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.views, [], "late registrations remain invalid while teardown waits");
		finishReturnedCleanup.resolve(); await tick(); await tick();
		assert.equal(activations, 2); assert.equal(f.imports.length, 2);
		assert.deepEqual(order, ["registered-cleanup-start", "registered-cleanup-end", "returned-cleanup-start", "returned-cleanup-end", "replacement-active"]);
		f.manager.dispose();
	});

	it("async cleanup rejection is visible, isolated, and settles the per-plugin teardown gate", async () => {
		const failCleanup = deferred<void>();
		let activations = 0;
		const f = fixture({ activate(ctx) {
			activations++;
			if (activations === 1) ctx.cleanup(async () => { await failCleanup.promise; });
		} });
		f.manager.reconcile([info()]); await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		f.manager.reconcile([info()]); await tick();
		assert.equal(activations, 1);
		failCleanup.reject(new Error("asynchronous cleanup failed")); await tick(); await tick();
		assert.equal(activations, 2);
		assert.equal(f.manager.getSnapshot().plugins[0]!.error, "asynchronous cleanup failed");
		f.manager.dispose();
	});

	it("activation errors isolate packages, clean partial registrations, and do not retry on refetch", async () => {
		let attempts = 0, cleaned = 0;
		const f = fixture({ activate(ctx) {
			if (ctx.manifest.id === "broken") {
				attempts++; ctx.registerView({ id: "partial", name: "Partial", mount() {} });
				ctx.cleanup(() => { cleaned++; }); throw new Error("activation exploded");
			}
			ctx.registerView({ id: "okay", name: "Okay", mount() {} });
		} });
		f.manager.reconcile([info("broken"), info("healthy")]); await tick();
		f.manager.reconcile([info("broken"), info("healthy")]); await tick();
		const [broken, healthy] = f.manager.getSnapshot().plugins;
		assert.ok(broken); assert.ok(healthy);
		assert.equal(broken.phase, "error"); assert.equal(broken.error, "activation exploded");
		assert.deepEqual(broken.views, []); assert.equal(healthy.views.length, 1);
		assert.equal(attempts, 1); assert.equal(cleaned, 1);
		f.manager.dispose();
	});

	it("unregistration is idempotent and duplicate ids fail visibly", async () => {
		let ctx!: PluginFrontendContext;
		const f = fixture({ activate(context) { ctx = context; } });
		f.manager.reconcile([info()]); await tick();
		const view = { id: "one", name: "One", mount() {} };
		const unregister = ctx.registerView(view);
		assert.throws(() => ctx.registerView({ id: "one", name: "Duplicate", mount() {} }), /Duplicate/);
		unregister(); unregister();
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.views, []);
		ctx.registerView(view); unregister();
		assert.equal(f.manager.getSnapshot().plugins[0]!.views.length, 1, "old unregister cannot remove a reused registration");
		const settings = () => {};
		const offSettings = ctx.registerSettings(settings); offSettings();
		ctx.registerSettings(settings); offSettings();
		assert.equal(f.manager.getSnapshot().plugins[0]!.settings, settings);
		f.manager.dispose();
	});

	it("malformed JavaScript view/action registrations fail activation instead of escaping routes or crashing React", async () => {
		for (const kind of ["view", "action"] as const) {
			const valid = { id: "safe", name: "Safe", mount() {}, run() {} };
			const cases: Array<{ value: unknown; error: RegExp }> = [
				{ value: null, error: /registration id/ },
				...["", ".", "..", "/", "../escape", "%2F", "has space", "a".repeat(129), 42, {}].map(id => ({ value: { ...valid, id }, error: /registration id/ })),
				...["", " \n\t", 42, {}, null].map(name => ({ value: { ...valid, name }, error: /registration name/ })),
				...[undefined, "not-a-function", {}].map(callback => ({ value: { ...valid, [kind === "view" ? "mount" : "run"]: callback }, error: /must be a function/ })),
			];
			for (const { value, error } of cases) {
				const f = fixture({ activate(ctx) {
					if (ctx.manifest.id === "healthy") { ctx.registerView({ id: "healthy", name: "Healthy", mount() {} }); return; }
					ctx.registerView({ id: "partial", name: "Partial", mount() {} });
					if (kind === "view") ctx.registerView(value as Parameters<PluginFrontendContext["registerView"]>[0]);
					else ctx.registerAction(value as Parameters<PluginFrontendContext["registerAction"]>[0]);
				} });
				f.manager.reconcile([info(), info("healthy")]); await tick();
				const [broken, healthy] = f.manager.getSnapshot().plugins;
				assert.equal(broken!.phase, "error", `${kind}: ${JSON.stringify(value)}`);
				assert.match(broken!.error!, error);
				assert.deepEqual(broken!.views, []); assert.deepEqual(broken!.actions, []);
				assert.equal(healthy!.phase, "active"); assert.equal(healthy!.views.length, 1);
				await f.manager.dispose();
			}
		}
	});

	it("registration accepts route-safe boundary IDs and names without coercion", async () => {
		const ids = ["A", "9_Name.value-1", `Z${"-".repeat(127)}`];
		const f = fixture({ activate(ctx) {
			for (const id of ids) {
				ctx.registerView({ id, name: "Proof", mount() {} });
				ctx.registerAction({ id, name: "Run proof", run() {} });
			}
		} });
		f.manager.reconcile([info()]); await tick();
		const plugin = f.manager.getSnapshot().plugins[0]!;
		assert.equal(plugin.phase, "active");
		assert.deepEqual(plugin.views.map(view => view.id), ids);
		assert.deepEqual(plugin.actions.map(action => action.id), ids);
		for (const id of ids) assert.equal(new URL(pluginViewPath("fixture", id), "http://localhost").pathname, pluginViewPath("fixture", id));
		await f.manager.dispose();
	});

	it("settings registration requires a runtime function and isolates invalid mounts", async () => {
		for (const invalid of [undefined, null, 42, "mount", {}]) {
			const f = fixture({ activate(ctx) { ctx.registerSettings(invalid as Parameters<PluginFrontendContext["registerSettings"]>[0]); } });
			f.manager.reconcile([info()]); await tick();
			const plugin = f.manager.getSnapshot().plugins[0]!;
			assert.equal(plugin.phase, "error"); assert.match(plugin.error!, /settings mount must be a function/);
			assert.equal(plugin.settings, undefined);
			await f.manager.dispose();
		}
	});

	it("dispose invalidates immediately and exposes an awaitable cooperative teardown", async () => {
		const release = deferred<void>();
		let ctx!: PluginFrontendContext, disposed = false;
		const f = fixture({ activate(context) { ctx = context; ctx.cleanup(() => release.promise); } });
		f.manager.reconcile([info()]); await tick();
		const completion = f.manager.dispose().then(() => { disposed = true; });
		assert.equal(ctx.signal.aborted, true); await tick(); assert.equal(disposed, false);
		release.resolve(); await completion; assert.equal(disposed, true);
		await f.manager.dispose();
	});

	it("throwing cleanups do not prevent remaining cleanup and are visible", async () => {
		let clean = 0;
		const f = fixture({ activate(ctx) {
			ctx.cleanup(() => { clean++; });
			ctx.cleanup(() => { throw new Error("cleanup failure"); });
		} });
		f.manager.reconcile([info()]); await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		assert.equal(clean, 1); assert.equal(f.manager.getSnapshot().plugins[0]!.error, "cleanup failure");
	});
});

describe("plugin renderer registration ownership", () => {
	it("publishes readonly registrations and lookup, and unregister immediately aborts its mounts", async () => {
		const dom = parseHTML("<html><body></body></html>");
		let unregister!: () => void;
		let signal!: AbortSignal;
		let cleaned = 0;
		const f = fixture({ activate(ctx) {
			unregister = ctx.registerCodeBlock({ language: "lesson", mount() {} });
			ctx.registerToolRenderer({ toolName: "custom_tool", mount() {} });
		} });
		f.manager.reconcile([info()]); await tick();
		const snapshot = f.manager.getSnapshot();
		assert.equal(Object.isFrozen(snapshot.codeBlocks), true); assert.equal(Object.isFrozen(snapshot.toolRenderers), true);
		assert.equal(snapshot.codeBlocks[0]!.pluginId, "fixture");
		assert.equal(f.manager.getCodeBlock("lesson"), snapshot.codeBlocks[0]);
		assert.equal(f.manager.getToolRenderer("custom_tool"), snapshot.toolRenderers[0]);
		const release = f.manager.mountRenderer(snapshot.codeBlocks[0]!, (_child, mountedSignal) => { signal = mountedSignal; return () => { cleaned++; }; }, dom.document.body as unknown as HTMLElement, assert.fail);
		await tick(); assert.equal(signal.aborted, false);
		unregister(); assert.equal(signal.aborted, true); assert.equal(cleaned, 1);
		assert.equal(dom.document.body.childElementCount, 0); release(); unregister(); assert.equal(cleaned, 1);
		assert.equal(f.manager.getCodeBlock("lesson"), undefined); assert.deepEqual(f.manager.getSnapshot().codeBlocks, []);
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		assert.equal(f.manager.getToolRenderer("custom_tool"), undefined);
		await f.manager.dispose();
	});

	it("host-reserved and globally colliding renderer names fail visibly without shadowing an owner", async () => {
		for (const kind of ["code", "tool"] as const) {
			const reserved = kind === "code" ? "mermaid" : "read";
			const collision = kind === "code" ? "lesson" : "custom_tool";
			const f = fixture({ activate(ctx) {
				const name = ctx.manifest.id === "reserved" ? reserved : collision;
				if (kind === "code") ctx.registerCodeBlock({ language: name, mount() {} });
				else ctx.registerToolRenderer({ toolName: name, mount() {} });
			} }, { reservedCodeBlockLanguages: ["mermaid"], reservedToolNames: ["read"] });
			f.manager.reconcile([info("owner"), info("collision"), info("reserved")]); await tick();
			const [owner, duplicate, builtin] = f.manager.getSnapshot().plugins;
			assert.equal(owner!.phase, "active");
			assert.equal(duplicate!.phase, "error"); assert.match(duplicate!.error!, /Duplicate plugin renderer/);
			assert.equal(builtin!.phase, "error"); assert.match(builtin!.error!, /reserved by the host/);
			const registrations = kind === "code" ? f.manager.getSnapshot().codeBlocks : f.manager.getSnapshot().toolRenderers;
			assert.equal(registrations.length, 1); assert.equal(registrations[0]!.pluginId, "owner");
			await f.manager.dispose();
		}
	});

	it("runtime renderer validation catches invalid keys and mount functions as isolated activation errors", async () => {
		for (const kind of ["code", "tool"] as const) {
			for (const value of [null, { key: 42, mount() {} }, { key: " \t", mount() {} }, { key: "valid", mount: 42 }]) {
				const f = fixture({ activate(ctx) {
					if (kind === "code") ctx.registerCodeBlock((value && { language: value.key, mount: value.mount }) as Parameters<PluginFrontendContext["registerCodeBlock"]>[0]);
					else ctx.registerToolRenderer((value && { toolName: value.key, mount: value.mount }) as Parameters<PluginFrontendContext["registerToolRenderer"]>[0]);
				} });
				f.manager.reconcile([info()]); await tick();
				assert.equal(f.manager.getSnapshot().plugins[0]!.phase, "error");
				assert.match(f.manager.getSnapshot().plugins[0]!.error!, /Plugin renderer/);
				assert.deepEqual(f.manager.getSnapshot().codeBlocks, []); assert.deepEqual(f.manager.getSnapshot().toolRenderers, []);
				await f.manager.dispose();
			}
		}
	});
});

describe("plugin host APIs", () => {
	it("call unwraps result, passes operation/input/signal, and exposes backend errors", async () => {
		let ctx!: PluginFrontendContext;
		const f = fixture({ activate(context) { ctx = context; } });
		f.manager.reconcile([info()]); await tick();
		assert.deepEqual(await ctx.call("snapshot", { count: 3 }), { answer: 42 });
		const request = f.requests[0]!;
		assert.equal(request.url, "/api/plugins/fixture/call");
		assert.equal(request.init?.method, "POST");
		assert.deepEqual(JSON.parse(String(request.init?.body)), { operation: "snapshot", input: { count: 3 } });
		assert.equal(request.init?.signal, ctx.signal);
		f.host.fetch = async () => Response.json({ error: "unknown operation" }, { status: 400 });
		await assert.rejects(ctx.call("nope"), /unknown operation/);
		f.manager.dispose();
		await assert.rejects(ctx.call("snapshot"), /no longer active/);
	});

	it("notifications are plugin-scoped, app events carry named payloads, and resync is explicit", async () => {
		const notifications: string[] = [], events: ServerEvent[] = [], resyncs: string[] = [];
		const f = fixture({ activate(ctx) {
			ctx.onNotification(event => { notifications.push(`${ctx.manifest.id}:${event.topic}`); });
			ctx.onAppEvent(event => { events.push(event); });
			ctx.onResync(() => { resyncs.push(ctx.manifest.id); });
		} });
		f.manager.reconcile([info("one"), info("two")]); await tick();
		f.manager.notify({ pluginId: "one", topic: "ready", data: { count: 1 } });
		f.manager.appEvent({ type: "turn-settled", chatId: "existing" });
		f.manager.appEvent({ type: "plugin-message", pluginId: "two", topic: "hidden" });
		f.manager.resync();
		assert.deepEqual(notifications, ["one:ready"]);
		assert.deepEqual(events, [{ type: "turn-settled", chatId: "existing" }, { type: "turn-settled", chatId: "existing" }]);
		assert.deepEqual(resyncs, ["one", "two"]);
		f.manager.dispose();
	});

	it("listener/action errors stay visible without breaking neighboring consumers", async () => {
		let good = 0;
		const f = fixture({ activate(ctx) {
			ctx.onNotification(() => { throw new Error("listener exploded"); });
			ctx.onNotification(() => { good++; });
			ctx.registerAction({ id: "broken", name: "Broken", async run() { throw new Error("action exploded"); } });
		} });
		f.manager.reconcile([info()]); await tick();
		f.manager.notify({ pluginId: "fixture", topic: "test" });
		assert.equal(good, 1); assert.equal(f.manager.getSnapshot().plugins[0]!.error, "listener exploded");
		await f.manager.runAction("fixture", f.manager.getSnapshot().plugins[0]!.actions[0]!, { placement: "sidebar", surface: "sidebar" });
		assert.equal(f.manager.getSnapshot().plugins[0]!.error, "action exploded");
		f.manager.dispose();
	});

	it("app navigation is host-owned and safely encodes route ids", async () => {
		let ctx!: PluginFrontendContext;
		const f = fixture({ activate(context) { ctx = context; } });
		f.manager.reconcile([info()]); await tick();
		assert.equal(ctx.app.pathname(), "/chat/existing");
		ctx.app.openSession("a/b"); ctx.app.openView("a/b"); ctx.app.openHome();
		assert.deepEqual(f.navigations, ["/chat/a%2Fb", "/plugins/fixture/a%2Fb", "/"]);
		assert.equal(pluginViewPath("fixture", "overview"), "/plugins/fixture/overview");
		assert.equal(pluginAssetUrl(info(), "main.js"), "/api/plugins/fixture/assets/main.js?revision=restart-1");
		f.manager.dispose();
	});
});

describe("plugin view and settings mounts", () => {
	it("settings registration is lazy, mounts have private DOM, and late mount cleanups cannot erase a new view", async () => {
		const dom = parseHTML("<html><body><div id='host'></div></body></html>");
		const container = dom.document.querySelector("#host") as unknown as HTMLElement;
		const completion = deferred<PluginCleanup>();
		let settingsMounts = 0, lateCleanups = 0, viewCleanups = 0;
		const f = fixture({ activate(ctx) { ctx.registerSettings(() => { settingsMounts++; }); } });
		f.manager.reconcile([info()]); await tick(); assert.equal(settingsMounts, 0);
		const settings = f.manager.getSnapshot().plugins[0]!.settings;
		assert.equal(typeof settings, "function");
		assert.ok(typeof settings === "function");
		const offSettings = f.manager.mount("fixture", settings, container, assert.fail);
		await tick(); assert.equal(settingsMounts, 1); offSettings();
		const offOld = f.manager.mount("fixture", async child => { child.textContent = "old"; return completion.promise; }, container, assert.fail);
		await tick(); offOld();
		const offNew = f.manager.mount("fixture", child => { child.textContent = "new"; return () => { viewCleanups++; }; }, container, assert.fail);
		await tick(); completion.resolve(() => { lateCleanups++; }); await tick();
		assert.equal(lateCleanups, 1); assert.equal(container.textContent, "new");
		offNew(); offNew(); assert.equal(viewCleanups, 1); assert.equal(container.textContent, "");
		f.manager.dispose();
	});

	it("disable cleans mounted views even before their React frame unmounts", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const container = dom.document.body as unknown as HTMLElement;
		let cleaned = 0;
		const f = fixture({ activate() {} });
		f.manager.reconcile([info()]); await tick();
		const off = f.manager.mount("fixture", child => { child.textContent = "mounted"; return () => { cleaned++; }; }, container, assert.fail);
		await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		assert.equal(cleaned, 1); assert.equal(container.textContent, ""); off(); assert.equal(cleaned, 1);
	});

	it("replacement activation also waits for a late mount-returned async cleanup", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const finishMount = deferred<PluginCleanup>(), finishCleanup = deferred<void>();
		let activations = 0, cleaning = false;
		const f = fixture({ activate() { activations++; } });
		f.manager.reconcile([info()]); await tick();
		f.manager.mount("fixture", () => finishMount.promise, dom.document.body as unknown as HTMLElement, assert.fail);
		await tick();
		f.manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]);
		f.manager.reconcile([info()]); await tick();
		assert.equal(activations, 1); assert.equal(dom.document.body.childElementCount, 0);
		finishMount.resolve(async () => { cleaning = true; await finishCleanup.promise; }); await tick();
		assert.equal(cleaning, true); assert.equal(activations, 1);
		finishCleanup.resolve(); await tick(); await tick();
		assert.equal(activations, 2);
		f.manager.dispose();
	});

	it("mount errors are caught and reported on the view and plugin row", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const errors: string[] = [];
		const f = fixture({ activate() {} });
		f.manager.reconcile([info()]); await tick();
		f.manager.mount("fixture", () => { throw new Error("mount exploded"); }, dom.document.body as unknown as HTMLElement, error => { errors.push(error); });
		await tick(); assert.deepEqual(errors, ["mount exploded"]);
		assert.equal(f.manager.getSnapshot().plugins[0]!.error, "mount exploded");
		assert.equal(dom.document.body.childElementCount, 0);
		f.manager.dispose();
	});

	it("StrictMode-style mount probe is inert", async () => {
		const dom = parseHTML("<html><body></body></html>");
		let mounts = 0;
		const f = fixture({ activate() {} });
		f.manager.reconcile([info()]); await tick();
		const mount = () => { mounts++; };
		f.manager.mount("fixture", mount, dom.document.body as unknown as HTMLElement, assert.fail)();
		const off = f.manager.mount("fixture", mount, dom.document.body as unknown as HTMLElement, assert.fail);
		await tick(); assert.equal(mounts, 1); off(); f.manager.dispose();
	});
});

describe("plugin management transport and window ownership", () => {
	it("reads the list envelope, refreshes explicitly, and PUTs enable state", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		let enabled = false;
		const f = fixture({ activate() {} }, { fetch: async (url, init) => {
			requests.push({ url: String(url), init });
			if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).enabled;
			return Response.json({ plugins: [info("fixture", { enabled, status: enabled ? "active" : "disabled" })], directory: "/writable/plugins" });
		} });
		await f.manager.reload();
		assert.equal(f.manager.getSnapshot().directory, "/writable/plugins");
		assert.equal(f.imports.length, 0);
		await f.manager.setEnabled("fixture", true); await tick();
		assert.equal(f.imports.length, 1);
		const put = requests.find(request => request.init?.method === "PUT")!;
		assert.equal(put.url, "/api/plugins/fixture"); assert.deepEqual(JSON.parse(String(put.init?.body)), { enabled: true });
		await f.manager.refresh();
		assert.deepEqual(JSON.parse(String(requests.find(request => request.init?.method === "POST")!.init?.body)), { action: "refresh" });
		f.manager.dispose();
	});

	it("disable invalidates an in-flight list and activation immediately, before PUT settles", async () => {
		const oldList = deferred<Response>(), put = deferred<Response>(), activation = deferred<void>();
		let ctx!: PluginFrontendContext;
		let lists = 0, cleaned = 0;
		const f = fixture({ async activate(context) { ctx = context; await activation.promise; ctx.registerView({ id: "late", name: "Late", mount() {} }); return () => { cleaned++; }; } }, {
			fetch: async (_url, init) => init?.method === "PUT" ? put.promise : ++lists === 1 ? oldList.promise : Response.json({ plugins: [info("fixture", { enabled: false, status: "disabled" })], directory: "/fixture" }),
		});
		f.manager.reconcile([info()]); await tick();
		const reloading = f.manager.reload();
		const disabling = f.manager.setEnabled("fixture", false);
		assert.equal(ctx.signal.aborted, true);
		oldList.resolve(Response.json({ plugins: [info()], directory: "/stale" })); await reloading;
		activation.resolve(); await tick(); assert.equal(cleaned, 1);
		assert.deepEqual(f.manager.getSnapshot().plugins[0]!.views, []);
		put.resolve(Response.json({})); await disabling;
		assert.equal(f.manager.getSnapshot().plugins[0]!.info.enabled, false);
		f.manager.dispose();
	});

	it("failed management requests stay visible after the truth reload", async () => {
		const f = fixture({ activate() {} }, { fetch: async (_url, init) => init?.method === "PUT"
			? Response.json({ error: "cannot write plugin state" }, { status: 500 })
			: Response.json({ plugins: [], directory: "/fixture" }) });
		await f.manager.setEnabled("fixture", true);
		assert.equal(f.manager.getSnapshot().error, "cannot write plugin state");
		f.manager.dispose();
	});

	it("StrictMode setup/cleanup/setup activates once and final release aborts async work", async () => {
		const completion = deferred<void>();
		let activated = 0, cleaned = 0;
		let signal!: AbortSignal;
		const f = fixture({ async activate(ctx) { activated++; signal = ctx.signal; await completion.promise; return () => { cleaned++; }; } }, {
			fetch: async () => Response.json({ plugins: [info()], directory: "/fixture" }),
		});
		const owner = createPluginWindowOwner(f.host);
		const firstRelease = owner.acquire(); firstRelease();
		const finalRelease = owner.acquire(); await tick();
		assert.equal(activated, 1); assert.equal(owner.disposed, false);
		finalRelease(); await tick(); assert.equal(owner.disposed, true); assert.equal(signal.aborted, true);
		completion.resolve(); await tick(); assert.equal(cleaned, 1);
	});
});

describe("plugin frontend surface and native importer", () => {
	it("real provider and Settings interactions keep activation window-scoped and settings lazy", async () => {
		const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
		const keys = ["window", "self", "document", "HTMLElement", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
		const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
		Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
			fetch: async () => { throw new Error("Core settings unavailable"); }, IS_REACT_ACT_ENVIRONMENT: true });
		let activated = 0, settingsMounts = 0, settingsCleanups = 0, activeSources = 0, enabled = true, refreshPosts = 0;
		let pendingRefresh: ReturnType<typeof deferred<Response>> | undefined;
		const actions: string[] = [], events: ServerEvent[] = [];
		const f = fixture({ activate(ctx) {
			activated++;
			ctx.registerView({ id: "overview", name: "Overview", mount() {} });
			ctx.registerAction({ id: "run", name: "Run fixture", run() { actions.push("run"); } });
			ctx.registerSettings(child => { settingsMounts++; child.textContent = "Fixture custom settings"; return () => { settingsCleanups++; }; });
			ctx.onAppEvent(event => { events.push(event); });
		} }, { fetch: async (_url, init) => {
			if (init?.method === "POST") { refreshPosts++; if (pendingRefresh) return pendingRefresh.promise; }
			if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).enabled;
			return Response.json({ plugins: [info("fixture", { enabled, status: enabled ? "active" : "disabled" })], directory: "/fixture/writable/plugins" });
		} });
		window.__lhPluginWindow = createPluginWindowOwner(f.host);
		const frames = new Map<string, (raw: string) => void>();
		const connect = (): NotifySource => {
			activeSources++;
			return { close() { activeSources--; }, onOpen() {}, onEvent(name, callback) { frames.set(name, callback); } };
		};
		const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
		const root = createRoot(document.querySelector("#root")!);
		const button = (text: string) => {
			const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text);
			assert.ok(result, text); return result;
		};
		const click = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new dom.window.Event("click", { bubbles: true })); }); };
		try {
			await act(async () => { root.render(<React.StrictMode><AppRouterContext.Provider value={router}><PathnameContext.Provider value="/plugins/fixture/overview"><ServerEventsProvider connect={connect}><PluginsProvider><SettingsDialogBody initialSection="plugins" onClose={() => {}} /></PluginsProvider></ServerEventsProvider></PathnameContext.Provider></AppRouterContext.Provider></React.StrictMode>); });
			assert.equal(activated, 1); assert.equal(activeSources, 1); assert.equal(settingsMounts, 0);
			assert.ok(document.body.textContent?.includes("/fixture/writable/plugins"));
			const ids = [...document.querySelectorAll('[data-testid]')].map(node => node.getAttribute("data-testid"));
			assert.ok(ids.indexOf("plugin-install-help") < ids.indexOf("plugin-authoring-help"));
			assert.ok(ids.indexOf("plugin-authoring-help") < ids.indexOf("plugin-directory"));
			assert.ok(ids.indexOf("plugin-directory") < ids.indexOf("plugin-fixture"));
			const refresh = document.querySelector<HTMLButtonElement>('[aria-label="Refresh plugins"]')!;
			assert.ok(document.querySelector('[data-testid="plugin-directory"]')?.contains(refresh));
			assert.equal(refresh.textContent, "");
			assert.equal(refresh.disabled, false);
			pendingRefresh = deferred<Response>();
			await click(refresh);
			assert.equal(refresh.getAttribute("aria-busy"), "true");
			assert.equal(refresh.disabled, true);
			assert.ok(refresh.querySelector("svg.animate-spin"));
			await click(refresh); assert.equal(refreshPosts, 1, "pending refresh cannot duplicate POSTs");
			await act(async () => { pendingRefresh!.resolve(Response.json({ error: "Synthetic refresh failure" }, { status: 500 })); await tick(); });
			assert.equal(refresh.disabled, false);
			assert.equal(refresh.getAttribute("aria-busy"), "false");
			assert.ok(document.querySelector('[data-testid="section-plugins"] [role="alert"]')?.textContent?.includes("Synthetic refresh failure"));
			pendingRefresh = undefined;
			await click(refresh); assert.equal(refreshPosts, 2);
			assert.equal(document.querySelector('[data-testid="section-plugins"] [role="alert"]'), null);
			assert.equal(document.querySelector('nav[aria-label="Plugin views"]'), null, "enabled plugin views do not create automatic navigation");
			const gear = document.querySelector<HTMLButtonElement>('[aria-label="Settings for Plugin fixture"]')!;
			assert.ok(gear);
			assert.equal(gear.nextElementSibling?.getAttribute("role"), "switch", "gear sits immediately left of toggle");
			assert.equal(document.querySelector('[data-testid="section-plugins"] a[href^="/plugins/"]'), null, "management does not list plugin views");
			assert.equal(document.body.textContent?.includes("Run fixture"), false, "management does not list actions");
			await click(gear); assert.equal(settingsMounts, 1);
			assert.ok(document.body.textContent?.includes("Fixture custom settings"), "plugin settings work despite core fetch failure");
			assert.equal(document.querySelector('[data-testid="settings-nav-plugin:fixture"]')?.getAttribute("aria-current"), "true");
			assert.deepEqual(actions, []);
			await click(button("Community plugins")); assert.equal(settingsCleanups, 1);
			await act(async () => { frames.get("record-changed")!(JSON.stringify({ chatId: "external" })); });
			assert.deepEqual(events, [{ type: "record-changed", chatId: "external" }]);
			await click(document.querySelector<HTMLButtonElement>('[role="switch"]')!);
			assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
			assert.equal(document.querySelector('nav[aria-label="Plugin views"]'), null);
			assert.equal(activated, 1);
			assert.equal(document.querySelector('[aria-label="Settings for Plugin fixture"]'), null, "disabled plugins have no settings gear");
			assert.equal(document.querySelector('[data-testid="settings-nav-plugin:fixture"]'), null);
			await act(async () => { await window.__lhPluginWindow!.manager.setEnabled("fixture", true); });
			await click(document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-plugin:fixture"]')!);
			assert.equal(settingsMounts, 2);
			await act(async () => { await window.__lhPluginWindow!.manager.setEnabled("fixture", false); });
			assert.equal(settingsCleanups, 2);
			assert.ok(document.querySelector('[data-testid="section-plugins"]'), "disable active plugin returns to management");
		} finally {
			await act(async () => { root.unmount(); });
			assert.equal(activeSources, 0);
			for (const key of keys) {
				const descriptor = saved.get(key);
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});

	it("native importer waits for the public module load before importing runtime assets", async () => {
		const dom = parseHTML("<html><head></head><body></body></html>");
		const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
		Object.assign(globalThis, { window: dom.window, document: dom.document });
		try {
			const imported: string[] = [];
			const loading = importPluginModule("/api/plugins/fixture/assets/main.js?revision=1");
			const script = document.querySelector("script")!;
			assert.equal(script.getAttribute("type"), "module");
			assert.equal(imported.length, 0);
			window.__lhImportPlugin = async url => { imported.push(url); return { activate() {} }; };
			script.dispatchEvent(new dom.window.Event("load"));
			await loading;
			assert.deepEqual(imported, ["/api/plugins/fixture/assets/main.js?revision=1"]);
		} finally {
			if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
			if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
		}
	});
	it("widgets safely render empty without a provider", () => {
		assert.equal(renderToStaticMarkup(<PluginWidgets />), "");
	});
	it("Settings explains trusted local code, broad access, restart recovery and directory install/refresh", () => {
		const html = renderToStaticMarkup(<PluginsSection />);
		for (const copy of ["trusted local code", "broad file and network access", "not sandboxed", "restarting LearnHarness", "disabled by default", "Refresh plugins", "How to install a plugin", "Build a plugin", "Download authoring skill", "npm run build", "Prebuilt packages", "Preserve", "data/"]) assert.ok(html.includes(copy), copy);
		const document = parseHTML(html).document;
		const help = document.querySelector('[data-testid="plugin-install-help"]')!;
		assert.equal(help.hasAttribute("open"), false);
		const trigger = help.querySelector("summary")!;
		assert.equal(trigger.textContent, "How to install a plugin");
		for (const style of ["list-none", "text-muted-foreground", "underline", "underline-offset-2", "hover:text-foreground", "[&::-webkit-details-marker]:hidden"]) assert.ok(trigger.classList.contains(style), style);
		assert.equal(help.contains(document.querySelector('[data-testid="plugin-authoring-help"]')), false);
		const download = document.querySelector('[data-testid="download-plugin-authoring"]')!;
		assert.equal(download.tagName, "A");
		assert.equal(download.getAttribute("href"), "/plugin-authoring/learnharness-plugins.zip");
		assert.equal(download.hasAttribute("download"), true);
		assert.equal(document.querySelector('[data-testid="plugin-authoring-help"]')?.querySelectorAll("p").length, 1);
		assert.equal(document.querySelector('[data-testid="plugin-authoring-help"] p')?.textContent, "Download the authoring skill for your coding agent.");
		const refresh = document.querySelector('[aria-label="Refresh plugins"]')!;
		assert.equal(refresh.textContent, "");
		assert.equal(refresh.hasAttribute("disabled"), true, "no provider means disabled");
		assert.ok(refresh.querySelector('svg[aria-hidden="true"]'));
		assert.ok(document.querySelector('[data-testid="plugin-directory"]')?.contains(refresh));
		const core = renderToStaticMarkup(<PluginsSection origin="core" />);
		for (const text of ["How to install a plugin", "Build a plugin", "Download authoring skill", "Refresh plugins"]) assert.equal(core.includes(text), false, text);
	});
	it("native ESM wrapper is a public module, with no dynamic evaluation or bundled import escape hatch", async () => {
		const script = await readFile(new URL("../public/plugin-loader.js", import.meta.url), "utf8");
		const provider = await readFile(new URL("../components/plugins.tsx", import.meta.url), "utf8");
		assert.match(script, /window\.__lhImportPlugin\s*=.*import\(url\)/);
		assert.match(provider, /script\.type = "module"/);
		assert.match(provider, /script\.src = "\/plugin-loader.js"/);
		assert.match(provider, /await window\.__lhPluginLoader/);
		assert.doesNotMatch(script + provider, /new Function|eval\(|webpackIgnore|turbopackIgnore/);
		assert.doesNotMatch(provider, /new EventSource|setInterval/);
	});
});

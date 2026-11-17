import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import type { PluginFrontendContext, PluginInfo, PluginActionContext, PluginSettingsRegistration } from "../src/core/plugins.ts";
import type { PluginUi } from "../src/core/plugin-ui.ts";

const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const sidebar: PluginActionContext = { placement: "sidebar", surface: "sidebar" };
const info: PluginInfo = { id: "fixture", origin: "community", enabled: true, status: "active", revision: "1", manifest: {
	apiVersion: 1, id: "fixture", name: "Fixture", version: "1.0.0", minAppVersion: "0.4.1", main: "main.js",
} };
function fixture(activate: (ctx: PluginFrontendContext) => void, extra: Partial<ConstructorParameters<typeof PluginFrontendManager>[0]> = {}) {
	return new PluginFrontendManager({ fetch: async () => Response.json({ plugins: [], directory: "/tmp/plugins" }),
		importModule: async () => ({ activate }), pathname: () => "/", navigate() {}, ...extra });
}

describe("explicit plugin chrome registrations", () => {
	it("registered views and actions create no placements; explicit placements retain order and are removed on disable", async () => {
		const manager = fixture(ctx => {
			ctx.registerView({ id: "view", name: "View", mount() {} });
			ctx.registerAction({ id: "open", name: "Open", run() {} });
		});
		manager.reconcile([info]); await tick();
		assert.equal(manager.getSnapshot().plugins[0]!.views.length, 1);
		assert.deepEqual(manager.getSnapshot().plugins[0]!.placements, []);
		await manager.dispose();
		const placed = fixture(ctx => {
			ctx.registerAction({ id: "open", name: "Open", run() {} });
			ctx.placeAction({ id: "graph", actionId: "open", location: "graph" });
			ctx.placeAction({ id: "sidebar", actionId: "open", location: "sidebar" });
			ctx.placeAction({ id: "lesson", actionId: "open", location: "top-bar", sessions: ["teaching"] });
		});
		placed.reconcile([info]); await tick();
		assert.deepEqual(placed.getSnapshot().plugins[0]!.placements.map(item => item.id), ["graph", "sidebar", "lesson"]);
		placed.reconcile([{ ...info, enabled: false, status: "disabled" }]);
		assert.deepEqual(placed.getSnapshot().plugins[0]!.placements, []);
		await placed.dispose();
	});
	it("rejects missing actions, duplicate ids, unknown locations and implicit top-bar targets", async () => {
		for (const placement of [
			{ id: "place", actionId: "missing", location: "graph" },
			{ id: "place", actionId: "open", location: "unknown" },
			{ id: "place", actionId: "open", location: "top-bar" },
			{ id: "place", actionId: "open", location: "top-bar", sessions: ["unknown"] },
		]) {
			const manager = fixture(ctx => {
				ctx.registerAction({ id: "open", name: "Open", run() {} });
				ctx.placeAction(placement as Parameters<PluginFrontendContext["placeAction"]>[0]);
			});
			manager.reconcile([info]); await tick();
			assert.equal(manager.getSnapshot().plugins[0]!.phase, "error");
			assert.deepEqual(manager.getSnapshot().plugins[0]!.placements, []);
			await manager.dispose();
		}
		const manager = fixture(ctx => {
			ctx.registerAction({ id: "open", name: "Open", run() {} });
			ctx.placeAction({ id: "same", actionId: "open", location: "graph" });
			ctx.placeAction({ id: "same", actionId: "open", location: "sidebar" });
		});
		manager.reconcile([info]); await tick();
		assert.match(manager.getSnapshot().plugins[0]!.error!, /Duplicate plugin placement/);
		await manager.dispose();
	});
	it("publishes action busy state, suppresses repeated execution, passes context and reevaluates disabled", async () => {
		let finish!: () => void, disabled = false;
		const seen: PluginActionContext[] = [];
		let context!: PluginFrontendContext;
		const manager = fixture(ctx => {
			context = ctx;
			ctx.registerAction({ id: "run", name: "Run", disabled: () => disabled, run: async value => {
				seen.push(value); await new Promise<void>(resolve => { finish = resolve; });
			} });
		});
		manager.reconcile([info]); await tick();
		const action = manager.getSnapshot().plugins[0]!.actions[0]!;
		const running = manager.runAction("fixture", action, sidebar);
		assert.deepEqual(manager.getSnapshot().plugins[0]!.actionBusy, ["run"]);
		await manager.runAction("fixture", action, sidebar);
		assert.deepEqual(seen, [sidebar]);
		finish(); await running;
		assert.deepEqual(manager.getSnapshot().plugins[0]!.actionBusy, []);
		disabled = true; context.refreshActions();
		await manager.runAction("fixture", action, sidebar);
		assert.equal(seen.length, 1);
		await manager.dispose();
		await manager.runAction("fixture", action, sidebar);
		assert.equal(seen.length, 1);
	});
	it("old unregister functions cannot delete replacement placements", async () => {
		const manager = fixture(ctx => {
			ctx.registerAction({ id: "run", name: "Run", run() {} });
			const off = ctx.placeAction({ id: "place", actionId: "run", location: "graph" });
			off(); ctx.placeAction({ id: "place", actionId: "run", location: "sidebar" }); off();
		});
		manager.reconcile([info]); await tick();
		assert.equal(manager.getSnapshot().plugins[0]!.placements[0]!.location, "sidebar");
		await manager.dispose();
	});
});

describe("plugin UI and settings lifecycle contracts", () => {
	it("constructs UI lazily, owns its lifetime and deep-links only while active", async () => {
		let context!: PluginFrontendContext, signal!: AbortSignal, creates = 0;
		const opened: string[] = [];
		const ui = {} as PluginUi;
		const manager = fixture(ctx => { context = ctx; }, {
			createUi: options => { creates++; signal = options.signal; return ui; },
			openSettings: id => { opened.push(id); },
		});
		manager.reconcile([info]); await tick();
		assert.equal(creates, 0); assert.equal(context.ui, ui); assert.equal(context.ui, ui); assert.equal(creates, 1);
		context.app.openSettings(); assert.deepEqual(opened, ["fixture"]);
		await manager.dispose(); assert.equal(signal.aborted, true);
		context.app.openSettings(); assert.deepEqual(opened, ["fixture"]);
	});
	it("accepts controlled schema rows without calling callbacks or persisting anything", async () => {
		let changes = 0;
		const schema = { rows: [{ key: "enabled", label: "Enabled", type: "toggle" as const, value: false, onChange() { changes++; } }] };
		const manager = fixture(ctx => { ctx.registerSettings(schema); });
		manager.reconcile([info]); await tick();
		assert.equal(manager.getSnapshot().plugins[0]!.settings, schema); assert.equal(changes, 0);
		await manager.dispose();
	});
	it("schema handles publish accepted values, validate updates, and become inert after disposal", async () => {
		let handle!: import("../src/core/plugin-ui.ts").PluginWidgetHandle<import("../src/core/plugin-ui.ts").PluginSettingsSchema>;
		let ctx!: PluginFrontendContext;
		const row = { key: "enabled", label: "Enabled", type: "toggle" as const, value: false, onChange() {} };
		const manager = fixture(context => { ctx = context; handle = context.registerSettings({ rows: [row] }); });
		manager.reconcile([info]); await tick();
		handle.update({ rows: [{ ...row, value: true }] });
		const updated = manager.getSnapshot().plugins[0]!.settings;
		assert.ok(updated && typeof updated !== "function"); assert.equal(updated.rows[0]!.value, true);
		assert.throws(() => handle.update({ rows: [{ ...row, value: "bad" } as unknown as typeof row] }), /toggle value/);
		assert.equal(manager.getSnapshot().plugins[0]!.settings, updated);
		handle.dispose(); handle.dispose();
		ctx.registerSettings({ rows: [row] });
		handle.update({ rows: [] }); handle.dispose();
		const replacement = manager.getSnapshot().plugins[0]!.settings;
		assert.ok(replacement && typeof replacement !== "function"); assert.equal(replacement.rows.length, 1);
		await manager.dispose();
	});
	it("isolates invalid settings schemas", async () => {
		for (const schema of [{ rows: null }, { rows: [{ key: "x", label: "X", type: "toggle", value: "yes", onChange() {} }] },
			{ rows: [{ key: "x", label: "X", type: "slider", value: 1, step: 0, onChange() {} }] }]) {
			const manager = fixture(ctx => { ctx.registerSettings(schema as PluginSettingsRegistration); });
			manager.reconcile([info]); await tick();
			assert.equal(manager.getSnapshot().plugins[0]!.phase, "error");
			assert.equal(manager.getSnapshot().plugins[0]!.settings, undefined);
			await manager.dispose();
		}
	});
});

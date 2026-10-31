import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createPluginHost, isPluginHostError, PluginHostError } from "../src/server/plugin-host.ts";
import type { PluginHostDependencies } from "../src/server/plugin-host.ts";
import type { PluginBackendContext, PluginLearningData, PluginInference } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import type { ServerEvent } from "../src/core/events.ts";
import { createPluginWorkerService } from "../src/agent/plugin-workers.ts";
import { createPluginTaskRecordStore } from "../src/store/plugin-task-records.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-host-"));
	const directory = path.join(root, "plugins");
	fs.mkdirSync(directory);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const listeners = new Set<(event: ServerEvent) => void>();
	const history: string[] = [];
	const notifications: unknown[] = [];
	let servicesCreated = 0;
	const deps: PluginHostDependencies = {
		directory, appVersion: "0.3.7",
		createServices() {
			servicesCreated++;
			return { learning: { directory: root, history } as unknown as PluginLearningData, inference: {} as PluginInference,
				agents: { dispose: async () => { history.push("agents"); } } as PluginAgentService,
				workers: { dispose: async () => { history.push("workers"); } } as PluginWorkerService,
				createBackgroundTool() { throw new Error("Unexpected background tool in host fixture"); } };
		},
		subscribeEvents(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		onNotification: n => notifications.push(n),
	};
	const host = createPluginHost(deps);
	t.after(() => host.dispose());
	function plugin(id = "example", extra: Record<string, unknown> = {}, backend = "exports.activate = ctx => { ctx.handle('context', () => ctx); };") {
		const dir = path.join(directory, id); fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs", ...extra }));
		fs.writeFileSync(path.join(dir, "backend.cjs"), backend);
		return dir;
	}
	return { root, directory, host, deps, plugin, history, notifications, listeners, servicesCreated: () => servicesCreated };
}
const status = (expected: number) => (e: unknown) => isPluginHostError(e) && e.status === expected;

test("host error brand is process-stable, shape-checked and rejects arbitrary numeric status", () => {
	assert.equal(isPluginHostError(new PluginHostError(404, "missing")), true);
	class OtherModuleHostError extends Error {
		constructor(public status: number, message: string) {
			super(message); Object.defineProperty(this, Symbol.for("learnharness.plugin-host-error"), { value: true });
		}
	}
	assert.equal(isPluginHostError(new OtherModuleHostError(409, "unavailable")), true);
	for (const value of [new Error("ordinary"), { status: 400, message: "unbranded" }, new PluginHostError(200, "success"), new PluginHostError(499, "not allowed"), { [Symbol.for("learnharness.plugin-host-error")]: true, status: 404, message: 42 }]) assert.equal(isPluginHostError(value), false);
});

test("factory has no IO; disabled discovery never evaluates backend; broken packages remain visible", async t => {
	const f = fixture(t);
	const absent = path.join(f.root, "absent");
	const unused = createPluginHost({ ...f.deps, directory: absent });
	assert.equal(fs.existsSync(absent), false); await unused.dispose();
	f.plugin("example", {}, "throw new Error('evaluated disabled code')");
	f.plugin("future", { apiVersion: 2 });
	const broken = f.plugin("broken"); fs.writeFileSync(path.join(broken, "manifest.json"), "{broken");
	f.plugin("newer", { minAppVersion: "1.0.0" });
	await Promise.all([f.host.initialize(), f.host.initialize()]);
	assert.equal(f.servicesCreated(), 0);
	assert.equal(f.host.list().find(p => p.id === "example")?.status, "disabled");
	assert.equal(f.host.list().filter(p => p.status === "error").length, 3);
	await f.host.setEnabled("example", true);
	assert.match(f.host.list().find(p => p.id === "example")!.error!, /evaluated disabled code/);
	assert.equal(f.history.at(-1), "agents");
});

test("native backend path/require, fresh activations, reverse cleanup, stale callbacks and unregister guards", async t => {
	const f = fixture(t);
	const dir = f.plugin("example", {}, `
		const path = require('node:path');
		const helper = require('./helper.cjs');
		exports.activate = ctx => {
			ctx.handle('context', () => ctx);
			ctx.handle('native', () => [__filename, path.basename(__dirname), helper]);
			ctx.cleanup(() => ctx.learning.history.push('first'));
			ctx.cleanup(() => ctx.learning.history.push('second'));
			ctx.events.on(() => { ctx.events.emit('seen', 'event'); throw Error('isolated'); });
			return () => ctx.learning.history.push('returned');
		};`);
	fs.writeFileSync(path.join(dir, "helper.cjs"), "module.exports = 42");
	await f.host.initialize(); await f.host.setEnabled("example", true);
	assert.deepEqual(await f.host.call("example", "native"), [fs.realpathSync(path.join(dir, "backend.cjs")), "example", 42]);
	const old = await f.host.call("example", "context") as PluginBackendContext;
	assert.throws(() => old.handle("bad/name", () => 0), /Invalid/);
	const off = old.handle("repeat", () => 1); off();
	old.handle("repeat", () => 2); off();
	assert.equal(await f.host.call("example", "repeat"), 2);
	assert.throws(() => old.handle("repeat", () => 3), /Duplicate/);
	const capturedListener = [...f.listeners][0]!;
	capturedListener({} as ServerEvent);
	assert.equal(f.notifications.length, 1);
	await f.host.setEnabled("example", false);
	assert.equal(old.signal.aborted, true);
	assert.deepEqual(f.history, ["returned", "second", "first", "workers", "agents"]);
	assert.equal(f.listeners.size, 0);
	await assert.rejects(f.host.call("example", "repeat"), status(409));
	old.events.emit("late"); capturedListener({} as ServerEvent);
	assert.equal(f.notifications.length, 1);
	assert.throws(() => old.handle("late", () => 0), /no longer active/);
	let lateCleaned = false; old.cleanup(() => { lateCleaned = true; }); assert.equal(lateCleaned, true);
	await f.host.setEnabled("example", true);
	assert.equal(f.servicesCreated(), 2);
	assert.notEqual(await f.host.call("example", "context"), old);
	old.events.emit("late-again"); assert.equal(f.notifications.length, 1);
});

test("activation failure tears down registered resources and exposes a diagnostic", async t => {
	const f = fixture(t);
	f.plugin("example", {}, `exports.activate = ctx => {
		ctx.cleanup(() => { ctx.learning.history.push('cleanup'); throw Error('cleanup failed'); });
		ctx.events.on(() => {}); ctx.handle('orphan', () => 1); throw Error('activation failed');
	};`);
	await f.host.initialize(); await f.host.setEnabled("example", true);
	assert.equal(f.listeners.size, 0);
	assert.deepEqual(f.history, ["cleanup", "workers", "agents"]);
	assert.match(f.host.list()[0]!.error!, /activation failed.*cleanup failed/);
	assert.equal(f.host.list()[0]!.enabled, true);
	await assert.rejects(f.host.call("example", "orphan"), status(409));
});

test("activation-owned workers are interrupted after abort and never replay on re-enable", async t => {
	const f = fixture(t); f.plugin();
	const original = f.deps.createServices;
	let engineRequests = 0, releases!: () => void;
	const gate = new Promise<void>(resolve => { releases = resolve; });
	f.deps.createServices = info => {
		const services = original(info);
		const workers = createPluginWorkerService({
			store: createPluginTaskRecordStore(path.join(info.dataDirectory, "tasks")), signal: info.signal,
			engineFor: async () => { engineRequests++; await gate; throw new Error("late engine rejection"); },
		});
		const dispose = workers.dispose.bind(workers);
		workers.dispose = async () => { assert.equal(info.signal.aborted, true); f.history.push("workers-after-abort"); await dispose(); };
		return { ...services, workers };
	};
	await f.host.initialize(); await f.host.setEnabled("example", true);
	const old = await f.host.call("example", "context") as PluginBackendContext;
	old.workers.register({ id: "fixture-worker", instructions: "Offline fixture", resultSchema: { type: "null" } });
	const accepted = old.workers.start("fixture-worker", { requestId: "host-disposal", input: null, prompt: "Synthetic task", model: { provider: "faux", id: "offline" }, purpose: "background", maxTurns: 1 });
	const outcome = old.workers.wait(accepted.id);
	await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(engineRequests, 1);
	await f.host.setEnabled("example", false);
	assert.equal(old.signal.aborted, true); assert.equal((await outcome).status, "interrupted");
	assert.ok(f.history.includes("workers-after-abort"));
	assert.throws(() => old.workers.start("fixture-worker", { requestId: "late", input: null, prompt: "Late", model: { provider: "faux", id: "offline" }, purpose: "background", maxTurns: 1 }), /disposed|disabled/);
	releases(); await new Promise<void>(resolve => setImmediate(resolve));
	await f.host.setEnabled("example", true);
	const current = await f.host.call("example", "context") as PluginBackendContext;
	assert.notEqual(current.workers, old.workers);
	assert.equal(current.workers.get(accepted.id).status, "interrupted");
	assert.equal(current.workers.get(accepted.id).error?.code, "interrupted");
	assert.equal(engineRequests, 1, "reactivation reads history without restarting work");
});

test("background-tool factory delegates to the activation service and rejects stale contexts", async t => {
	const f = fixture(t); f.plugin(); const original = f.deps.createServices;
	let factoryCalls = 0;
	f.deps.createServices = info => ({ ...original(info), createBackgroundTool(context, definition) {
		assert.deepEqual(context, { chatId: "synthetic", agent: "teacher" }); factoryCalls++;
		return { ...definition, execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: null }) };
	} });
	await f.host.initialize(); await f.host.setEnabled("example", true);
	const ctx = await f.host.call("example", "context") as PluginBackendContext;
	const definition = { name: "fixture_background", label: "Fixture", description: "Offline fixture", parameters: { type: "object" }, workerId: "worker",
		prepare: () => ({ input: null, prompt: "Synthetic", model: { provider: "faux", id: "offline" }, maxTurns: 1 }), format: () => ({ text: "Synthetic result" }) };
	assert.equal(ctx.createBackgroundTool({ chatId: "synthetic", agent: "teacher" }, definition).name, "fixture_background");
	await f.host.setEnabled("example", false);
	assert.throws(() => ctx.createBackgroundTool({ chatId: "synthetic", agent: "teacher" }, definition), /no longer active/);
	assert.equal(factoryCalls, 1);
});

test("frontend-only assets are explicitly allowlisted, immutable by revision, and fail closed on symlinks", async t => {
	const f = fixture(t);
	const dir = f.plugin("example", { backend: undefined, main: "main.js", styles: "style.css" });
	fs.writeFileSync(path.join(dir, "main.js"), "export const version = 1");
	fs.writeFileSync(path.join(dir, "style.css"), "body{}");
	fs.writeFileSync(path.join(dir, ".env"), "SECRET");
	fs.mkdirSync(path.join(dir, "assets"));
	fs.writeFileSync(path.join(dir, "assets", "image.svg"), "<svg/>");
	fs.mkdirSync(path.join(dir, "data")); fs.writeFileSync(path.join(dir, "data", "private.json"), "{}");
	await f.host.initialize();
	assert.throws(() => f.host.asset("example", ["main.js"]), status(409));
	await f.host.setEnabled("example", true);
	assert.equal(f.servicesCreated(), 0);
	assert.equal(f.host.list()[0]!.status, "active");
	assert.match(f.host.asset("example", ["main.js"]).contentType, /javascript/);
	assert.equal(f.host.asset("example", ["assets", "image.svg"]).contentType, "image/svg+xml");
	for (const parts of [["backend.cjs"], [".env"], ["data", "private.json"], ["manifest.json"], ["assets", "..", "main.js"], ["assets/image.svg"], ["%2e%2e"], ["assets", ".env"]]) assert.throws(() => f.host.asset("example", parts));
	const revision = f.host.list()[0]!.revision;
	fs.writeFileSync(path.join(dir, "main.js"), "export const version = 2");
	await f.host.refresh();
	assert.match(f.host.list()[0]!.error!, /Restart required/);
	assert.equal(f.host.list()[0]!.revision, revision);
	assert.equal(Buffer.from(f.host.asset("example", ["main.js"]).bytes).toString(), "export const version = 1");
	fs.unlinkSync(path.join(dir, "assets", "image.svg"));
	fs.symlinkSync(path.join(dir, "data", "private.json"), path.join(dir, "assets", "image.svg"));
	assert.throws(() => f.host.asset("example", ["assets", "image.svg"]), status(404));
	fs.rmSync(path.join(dir, "assets"), { recursive: true });
	fs.symlinkSync(path.join(dir, "data"), path.join(dir, "assets"));
	assert.throws(() => f.host.asset("example", ["assets", "private.json"]), status(404));
	await f.host.setEnabled("example", false); await f.host.setEnabled("example", true);
	assert.equal(f.host.list()[0]!.status, "error");
});

test("state persistence, corrupt/future state refusal, atomic writes, and refresh discovery", async t => {
	const f = fixture(t); f.plugin();
	await Promise.all([f.host.initialize(), f.host.setEnabled("example", true), f.host.setEnabled("example", false), f.host.setEnabled("example", true)]);
	assert.equal(f.servicesCreated(), 2);
	const statePath = path.join(f.root, "plugins-state.json");
	assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { version: 1, enabled: { example: true } });
	assert.equal(fs.readdirSync(f.root).some(p => p.endsWith(".tmp")), false);
	const restarted = createPluginHost(f.deps); t.after(() => restarted.dispose());
	await restarted.initialize(); assert.equal(restarted.list()[0]!.status, "active");
	f.plugin("new-package"); await f.host.refresh();
	assert.equal(f.host.list().find(p => p.id === "new-package")?.status, "disabled");
	for (const bad of ['{"version":2,"enabled":{}}', "{broken", '{"version":1,"enabled":{"example":"true"}}']) {
		fs.writeFileSync(statePath, bad);
		await assert.rejects(f.host.setEnabled("example", false));
		assert.equal(fs.readFileSync(statePath, "utf8"), bad);
		const broken = createPluginHost(f.deps); await assert.rejects(broken.initialize()); await broken.dispose();
		assert.equal(fs.readFileSync(statePath, "utf8"), bad);
	}
});

test("backend edits are restart-only; stale module is not replaced by refresh or toggles", async t => {
	const f = fixture(t); const dir = f.plugin();
	await f.host.initialize(); await f.host.setEnabled("example", true);
	const revision = f.host.list()[0]!.revision;
	fs.writeFileSync(path.join(dir, "backend.cjs"), "throw Error('new code must not execute')");
	await f.host.refresh();
	assert.equal(f.host.list()[0]!.revision, revision);
	assert.match(f.host.list()[0]!.error!, /Restart required/);
	assert.ok(await f.host.call("example", "context"));
	await f.host.setEnabled("example", false); await f.host.setEnabled("example", true);
	assert.equal(f.host.list()[0]!.status, "error");
	assert.match(f.host.list()[0]!.error!, /Restart required/);
});

test("partial bundled installations block first loads and existing active backends", async t => {
	const f = fixture(t); f.plugin();
	await f.host.initialize(); await f.host.setEnabled("example", true);
	const markers = path.join(f.root, "plugins-installing"); fs.mkdirSync(markers);
	fs.writeFileSync(path.join(markers, "example.json"), "{}");
	fs.writeFileSync(path.join(markers, "first-install.json"), "{}");
	await f.host.refresh();
	assert.equal(f.host.list().length, 2);
	assert.equal(f.host.list().every(p => p.status === "error"), true);
	await assert.rejects(f.host.call("example", "context"), status(409));
	assert.match(f.host.list().find(p => p.id === "first-install")!.error!, /incomplete/);
});

test("dispose/disable abort cooperative pending activation and disposed host rejects all work", async t => {
	const f = fixture(t);
	f.plugin("example", {}, `exports.activate = async ctx => { ctx.handle('context', () => ctx); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, {once:true})); };`);
	await f.host.initialize();
	const enabling = f.host.setEnabled("example", true);
	// A service factory resolves the synchronization point without timing/sleeps.
	let started!: () => void;
	const startedPromise = new Promise<void>(r => { started = r; });
	const original = f.deps.createServices;
	f.deps.createServices = info => { const services = original(info); started(); return services; };
	await startedPromise;
	await Promise.all([enabling, f.host.setEnabled("example", false)]);
	assert.equal(f.host.list()[0]!.status, "disabled");
	let startedAgain!: () => void;
	const again = new Promise<void>(r => { startedAgain = r; });
	f.deps.createServices = info => { const services = original(info); startedAgain(); return services; };
	const nextEnable = f.host.setEnabled("example", true); await again;
	await Promise.all([nextEnable, f.host.dispose(), f.host.dispose()]);
	await assert.rejects(f.host.initialize(), status(503));
	await assert.rejects(f.host.refresh(), status(503));
	await assert.rejects(f.host.call("example", "context"), status(503));
	await assert.rejects(f.host.setEnabled("example", true), status(503));
	assert.throws(() => f.host.list(), status(503));
});

test("expected transport errors are typed; arbitrary handler failures remain server exceptions", async t => {
	const f = fixture(t); f.plugin(); await f.host.initialize(); await f.host.setEnabled("example", true);
	const ctx = await f.host.call("example", "context") as PluginBackendContext;
	ctx.handle("fail", () => { throw Error("plugin failure"); });
	await assert.rejects(f.host.call("example", "fail"), e => e instanceof Error && !(e instanceof PluginHostError));
	await assert.rejects(f.host.call("missing", "context"), status(404));
	await assert.rejects(f.host.call("example", "missing"), status(404));
	await assert.rejects(f.host.call("example", "../bad"), status(400));
});

/**
 * Plugin lifecycle hooks (beforeLoad/beforeQuit backend exports) and the
 * ctx.host control (hold, idle, restart, data formats) in
 * src/server/plugin-host.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { createPluginHost, type PluginHostDependencies } from "../src/server/plugin-host.ts";
import type { PluginBackendContext, PluginInference, PluginLearningData } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import { CURRENT_DATA_FORMATS } from "../src/core/data-format.ts";
import { activeHold, beginWork, IDLE_DEBOUNCE_MS, resetHostHoldForTests } from "../src/core/host-hold.ts";

afterEach(() => resetHostHoldForTests());

function fixture(t: TestContext, extraDeps: Partial<PluginHostDependencies> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lifecycle-"));
	const directory = path.join(root, "plugins");
	fs.mkdirSync(directory);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const deps: PluginHostDependencies = {
		directory, appVersion: "0.6.1", learningDirectory: root,
		createServices() {
			return { learning: { directory: root } as unknown as PluginLearningData, inference: {} as PluginInference,
				agents: { dispose: async () => {} } as PluginAgentService,
				workers: { dispose: async () => {} } as PluginWorkerService,
				createBackgroundTool() { throw new Error("unused"); } };
		},
		...extraDeps,
	};
	const host = createPluginHost(deps);
	t.after(() => host.dispose());
	function plugin(id: string, backend: string, enabled = true) {
		const dir = path.join(directory, id, "dist"); fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs" }));
		fs.writeFileSync(path.join(dir, "backend.cjs"), backend);
		const stateFile = path.join(root, "plugins-state.json");
		const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { version: 1, enabled: {} };
		state.enabled[id] = enabled;
		fs.writeFileSync(stateFile, JSON.stringify(state));
		return dir;
	}
	const log = (root: string) => { const file = path.join(root, "log.txt"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []; };
	return { root, directory, host, plugin, log: () => log(root) };
}

const logger = (root: string) => `const fs = require('node:fs'); const log = line => fs.appendFileSync(${JSON.stringify(path.join(root, "log.txt"))}, line + '\\n');`;

test("beforeLoad runs for enabled plugins before any activation, with a lifecycle context", async t => {
	const f = fixture(t);
	f.plugin("alpha", `${logger(f.root)}
		exports.beforeLoad = async ctx => { log('alpha:beforeLoad ' + JSON.stringify({ id: ctx.manifest.id, learning: ctx.learningDirectory, formats: ctx.dataFormats, data: require('node:path').basename(ctx.dataDirectory), aborted: ctx.signal.aborted })); };
		exports.activate = () => { log('alpha:activate'); };`);
	f.plugin("beta", `${logger(f.root)} exports.activate = () => { log('beta:activate'); };`);
	f.plugin("gamma", `${logger(f.root)} exports.beforeLoad = () => log('gamma:beforeLoad'); exports.activate = () => {};`, false);
	let announced: string[] = [];
	const results = await f.host.runBeforeLoad(AbortSignal.timeout(5000), names => { announced = names; });
	assert.deepEqual(results, [{ id: "alpha" }]);
	assert.deepEqual(announced, ["Plugin alpha"]);
	assert.deepEqual(f.log(), [`alpha:beforeLoad ${JSON.stringify({ id: "alpha", learning: f.root, formats: CURRENT_DATA_FORMATS, data: "data", aborted: false })}`]);
	await f.host.initialize();
	assert.deepEqual(f.log().slice(1).sort(), ["alpha:activate", "beta:activate"]);
	await assert.rejects(f.host.runBeforeLoad(AbortSignal.timeout(1000)), /before plugin initialization/);
});

test("initialization rediscovers state changed by beforeLoad (e.g. a pull)", async t => {
	const f = fixture(t);
	f.plugin("delta", `${logger(f.root)} exports.activate = () => log('delta:activate');`, false);
	f.plugin("sync", `${logger(f.root)}
		exports.beforeLoad = () => { const file = ${JSON.stringify(path.join(f.root, "plugins-state.json"))}; const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.enabled.delta = true; fs.writeFileSync(file, JSON.stringify(s)); };
		exports.activate = () => {};`);
	await f.host.runBeforeLoad(AbortSignal.timeout(5000));
	await f.host.initialize();
	assert.deepEqual(f.log(), ["delta:activate"]);
});

test("a failing hook is reported and does not stop the others", async t => {
	const f = fixture(t);
	f.plugin("a1", `exports.beforeLoad = () => { throw new Error('remote unreachable'); }; exports.activate = () => {};`);
	f.plugin("a2", `${logger(f.root)} exports.beforeLoad = () => log('a2'); exports.activate = () => {};`);
	const results = await f.host.runBeforeLoad(AbortSignal.timeout(5000));
	assert.deepEqual(results, [{ id: "a1", error: "remote unreachable" }, { id: "a2" }]);
	assert.deepEqual(f.log(), ["a2"]);
});

test("the shared signal stops waiting for a hook that ignores it and skips the rest", async t => {
	const f = fixture(t);
	f.plugin("h1", `exports.beforeLoad = () => new Promise(() => {}); exports.activate = () => {};`);
	f.plugin("h2", `${logger(f.root)} exports.beforeLoad = () => log('h2'); exports.activate = () => {};`);
	const skip = new AbortController();
	setTimeout(() => skip.abort(), 30);
	const results = await f.host.runBeforeLoad(skip.signal);
	assert.equal(results.length, 2);
	assert.match(results[0]!.error!, /Stopped/);
	assert.match(results[1]!.error!, /Skipped/);
	assert.deepEqual(f.log(), []);
	await f.host.initialize(); // startup continues
	assert.equal(f.host.list().find(p => p.id === "h1")?.status, "active");
});

test("a non-function hook export is an activation error", async t => {
	const f = fixture(t);
	f.plugin("bad", `exports.beforeQuit = 42; exports.activate = () => {};`);
	await f.host.initialize();
	assert.match(f.host.list().find(p => p.id === "bad")!.error!, /beforeQuit must be a function/);
});

test("beforeQuit runs for active plugins only and hasBeforeQuit follows enablement", async t => {
	const f = fixture(t);
	f.plugin("q1", `${logger(f.root)} exports.beforeQuit = ctx => log('q1 ' + ctx.signal.aborted); exports.activate = () => {};`);
	f.plugin("q2", `${logger(f.root)} exports.activate = () => {};`);
	await f.host.initialize();
	assert.equal(f.host.hasBeforeQuit(), true);
	assert.deepEqual(await f.host.runBeforeQuit(AbortSignal.timeout(5000)), [{ id: "q1" }]);
	assert.deepEqual(f.log(), ["q1 false"]);
	await f.host.setEnabled("q1", false);
	assert.equal(f.host.hasBeforeQuit(), false);
	assert.deepEqual(await f.host.runBeforeQuit(AbortSignal.timeout(5000)), []);
});

test("ctx.host: hold only while idle, released and aborted on deactivation", async t => {
	const f = fixture(t);
	f.plugin("holder", `exports.activate = ctx => { ctx.handle('ctx', () => ctx); };`);
	await f.host.initialize();
	const ctx = await f.host.call("holder", "ctx") as PluginBackendContext;
	assert.deepEqual(ctx.host.dataFormats, CURRENT_DATA_FORMATS);
	assert.throws(() => ctx.host.acquireHold({ reason: " " }), /nonempty reason/);
	const work = beginWork("turn", "c");
	assert.equal(ctx.host.acquireHold({ reason: "GitHub Sync is syncing" }), null);
	work.end();
	const hold = ctx.host.acquireHold({ reason: "GitHub Sync is syncing" })!;
	assert.equal(activeHold()?.owner, "holder");
	await f.host.setEnabled("holder", false);
	assert.equal(hold.signal.aborted, true);
	assert.equal(activeHold(), null);
});

test("ctx.host.onIdle fires on the busy→idle edge until deactivation", async t => {
	const f = fixture(t);
	f.plugin("idler", `exports.activate = ctx => { ctx.handle('ctx', () => ctx); };`);
	await f.host.initialize();
	const ctx = await f.host.call("idler", "ctx") as PluginBackendContext;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let idle = 0;
	ctx.host.onIdle(() => { idle++; });
	beginWork("job", "j").end();
	t.mock.timers.tick(IDLE_DEBOUNCE_MS);
	assert.equal(idle, 1);
	t.mock.timers.reset();
	await f.host.setEnabled("idler", false);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	beginWork("job", "j2").end();
	t.mock.timers.tick(IDLE_DEBOUNCE_MS);
	assert.equal(idle, 1);
});

test("ctx.host.requestRestart is unavailable without a desktop shell and delegates when wired", async t => {
	const bare = fixture(t);
	bare.plugin("r", `exports.activate = ctx => { ctx.handle('restart', () => ctx.host.requestRestart()); };`);
	await bare.host.initialize();
	assert.deepEqual(await bare.host.call("r", "restart"), { restarted: false, reason: "unavailable" });
	let asked = 0;
	const wired = fixture(t, { requestRestart: async () => { asked++; return { restarted: true }; } });
	wired.plugin("r", `exports.activate = ctx => { ctx.handle('restart', () => ctx.host.requestRestart()); };`);
	await wired.host.initialize();
	assert.deepEqual(await wired.host.call("r", "restart"), { restarted: true });
	assert.equal(asked, 1);
});

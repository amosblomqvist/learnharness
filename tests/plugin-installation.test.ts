import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { installBundledPlugins, pendingBundledPluginIds, syncPluginInstallationDirectory } from "../src/store/plugin-installation.ts";
import { createPluginHost } from "../src/server/plugin-host.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import type { PluginInference, PluginLearningData } from "../src/core/plugins.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "bundled"), plugins = path.join(root, "plugins");
	fs.mkdirSync(source);
	function plugin(id = "official") {
		const dir = path.join(source, id); fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: "Official", version: "1.0.0", minAppVersion: "0.3.0", main: "main.js", styles: "style.css" }));
		fs.writeFileSync(path.join(dir, "main.js"), "export const version = 1");
		fs.writeFileSync(path.join(dir, "style.css"), "body{}");
		fs.mkdirSync(path.join(dir, "assets"));
		fs.writeFileSync(path.join(dir, "assets", "old.txt"), "old asset");
		return dir;
	}
	const host = (installationErrors?: Record<string, string>) => {
		const h = createPluginHost({ directory: plugins, appVersion: "0.3.7", installationErrors, createServices() { throw Error("frontend-only must not create services"); } });
		t.after(() => h.dispose()); return h;
	};
	return { root, source, plugins, plugin, host, install: () => installBundledPlugins(source, plugins, "0.3.7") };
}

test("directory fsync skips Windows only and preserves POSIX IO failures", () => {
	const calls: unknown[] = [];
	const io = {
		openSync: (filename: fs.PathLike, flags: fs.OpenMode) => { calls.push(["open", filename, flags]); return 42; },
		fsyncSync: (fd: number) => { calls.push(["fsync", fd]); },
		closeSync: (fd: number) => { calls.push(["close", fd]); },
	};
	syncPluginInstallationDirectory("directory", { platform: "win32", io });
	assert.deepEqual(calls, []); // No Windows directory handle or flush attempt.
	for (const platform of ["darwin", "linux"] as const) {
		calls.length = 0;
		syncPluginInstallationDirectory("directory", { platform, io });
		assert.deepEqual(calls, [["open", "directory", "r"], ["fsync", 42], ["close", 42]]);
	}
	const accessError = Object.assign(Error("cannot open directory"), { code: "EACCES" });
	assert.throws(() => syncPluginInstallationDirectory("directory", { platform: "linux", io: { ...io, openSync: () => { throw accessError; } } }), error => error === accessError);
	const syncError = Object.assign(Error("cannot flush directory"), { code: "EIO" });
	calls.length = 0;
	assert.throws(() => syncPluginInstallationDirectory("directory", { platform: "darwin", io: { ...io, fsyncSync: () => { throw syncError; } } }), error => error === syncError);
	assert.deepEqual(calls, [["open", "directory", "r"], ["close", 42]]);
});

test("deterministic bundled install defaults disabled, safely updates owned files, preserves data and unrelated assets", async t => {
	const f = fixture(t); const shipped = f.plugin(); f.install();
	const installed = path.join(f.plugins, "official");
	const metadata = path.join(f.root, "plugins-bundled.json");
	const first = fs.readFileSync(metadata, "utf8"); f.install();
	assert.equal(fs.readFileSync(metadata, "utf8"), first);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
	assert.equal(fs.existsSync(path.join(installed, "data")), false);
	const host = f.host(); await host.initialize();
	assert.equal(host.list()[0]!.status, "disabled");
	fs.mkdirSync(path.join(installed, "data"));
	fs.writeFileSync(path.join(installed, "data", "records.json"), '{"valuable":true}');
	fs.writeFileSync(path.join(installed, "assets", "personal.txt"), "not owned");
	fs.unlinkSync(path.join(shipped, "assets", "old.txt"));
	fs.writeFileSync(path.join(shipped, "assets", "new.txt"), "new");
	fs.writeFileSync(path.join(shipped, "main.js"), "export const version = 2");
	f.install();
	assert.equal(fs.readFileSync(path.join(installed, "data", "records.json"), "utf8"), '{"valuable":true}');
	assert.equal(fs.readFileSync(path.join(installed, "assets", "personal.txt"), "utf8"), "not owned");
	assert.equal(fs.existsSync(path.join(installed, "assets", "old.txt")), false);
	assert.equal(fs.readFileSync(path.join(installed, "assets", "new.txt"), "utf8"), "new");
	assert.equal(fs.readFileSync(path.join(installed, "main.js"), "utf8"), "export const version = 2");
	await host.refresh(); assert.match(host.list()[0]!.error!, /Restart required/);
});

test("validates all packages before mutation and rejects reserved data, hidden files, symlinks and incompatible manifests", t => {
	for (const scenario of ["data", "hidden", "symlink", "incompatible", "missing", "directory"]) {
		const f = fixture(t); const dir = f.plugin();
		if (scenario === "data") fs.mkdirSync(path.join(dir, "data"));
		if (scenario === "hidden") fs.writeFileSync(path.join(dir, ".env"), "secret");
		if (scenario === "symlink") fs.symlinkSync(path.join(dir, "main.js"), path.join(dir, "assets", "link.js"));
		if (scenario === "incompatible") {
			const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
			manifest.minAppVersion = "9.0.0"; fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
		}
		if (scenario === "missing") fs.unlinkSync(path.join(dir, "main.js"));
		if (scenario === "directory") fs.mkdirSync(path.join(dir, "backend"));
		const report = f.install();
		assert.equal(typeof report.errors.official, "string", scenario);
		assert.equal(fs.existsSync(path.join(f.plugins, "official")), false);
	}
});

test("external ID collisions fail visibly without modifying the existing package", t => {
	const f = fixture(t); f.plugin();
	const existing = path.join(f.plugins, "official"); fs.mkdirSync(existing, { recursive: true });
	fs.writeFileSync(path.join(existing, "manifest.json"), "external package");
	assert.match(f.install().errors.official!, /collides with an external/);
	assert.equal(fs.readFileSync(path.join(existing, "manifest.json"), "utf8"), "external package");
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
});

test("constructor is not inherited bundled ownership: external code and data survive every metadata path", t => {
	for (const metadata of ["absent", "existing", "same-run"]) {
		const f = fixture(t);
		if (metadata === "existing") { f.plugin("another"); assert.equal(Object.keys(f.install().errors).length, 0); }
		if (metadata === "same-run") f.plugin("another"); // Publishes ownership before constructor in this invocation.
		f.plugin("constructor");
		const existing = path.join(f.plugins, "constructor");
		fs.mkdirSync(path.join(existing, "data"), { recursive: true });
		fs.writeFileSync(path.join(existing, "manifest.json"), "external manifest");
		fs.writeFileSync(path.join(existing, "main.js"), "external code");
		fs.writeFileSync(path.join(existing, "data", "keep.json"), '{"valuable":true}');
		const report = f.install();
		assert.equal(Object.hasOwn(report.errors, "constructor"), true, metadata);
		const id: string = "constructor";
		assert.match(report.errors[id]!, /collides with an external/, metadata);
		assert.equal(fs.readFileSync(path.join(existing, "manifest.json"), "utf8"), "external manifest", metadata);
		assert.equal(fs.readFileSync(path.join(existing, "main.js"), "utf8"), "external code", metadata);
		assert.equal(fs.readFileSync(path.join(existing, "data", "keep.json"), "utf8"), '{"valuable":true}', metadata);
		assert.deepEqual(pendingBundledPluginIds(f.plugins), [], metadata);
	}
	const bundled = fixture(t); bundled.plugin("constructor");
	assert.equal(Object.keys(bundled.install().errors).length, 0);
	assert.equal(Object.keys(bundled.install().errors).length, 0); // A genuinely owned constructor ID still updates.
});

function interruptRename(t: TestContext, destination: string, action: () => { errors: Record<string, string> }) {
	const original = fs.renameSync;
	const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
		if (to === destination) throw Object.assign(Error("simulated interrupted installation"), { code: "EIO" });
		return original(from, to);
	});
	syncBuiltinESMExports();
	try {
		const report = action(); assert.match(report.errors.official!, /simulated interrupted/); return report;
	} finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

test("interrupted first installation has a durable marker, blocks host evaluation, and retries to completion", async t => {
	const f = fixture(t); f.plugin();
	interruptRename(t, path.join(f.plugins, "official", "manifest.json"), f.install);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), ["official"]);
	assert.equal(fs.existsSync(path.join(f.plugins, "official", "manifest.json")), false);
	const blocked = f.host(); await blocked.initialize();
	assert.equal(blocked.list()[0]!.status, "error");
	assert.match(blocked.list()[0]!.error!, /incomplete/);
	f.install(); assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
	const fresh = f.host(); await fresh.initialize();
	assert.equal(fresh.list()[0]!.status, "disabled");
});

test("interrupted update preserves data; retry cleans union of old, intermediate and latest owned assets", async t => {
	const f = fixture(t); const source = f.plugin(); f.install();
	const installed = path.join(f.plugins, "official");
	fs.mkdirSync(path.join(installed, "data")); fs.writeFileSync(path.join(installed, "data", "keep.txt"), "safe");
	fs.unlinkSync(path.join(source, "assets", "old.txt"));
	fs.writeFileSync(path.join(source, "assets", "intermediate.txt"), "partial update");
	fs.writeFileSync(path.join(source, "main.js"), "new code");
	interruptRename(t, path.join(installed, "main.js"), f.install);
	assert.equal(fs.existsSync(path.join(installed, "assets", "intermediate.txt")), true);
	const blocked = f.host(); await blocked.initialize();
	assert.match(blocked.list()[0]!.error!, /incomplete/);
	fs.unlinkSync(path.join(source, "assets", "intermediate.txt"));
	fs.writeFileSync(path.join(source, "assets", "latest.txt"), "latest update");
	f.install();
	assert.equal(fs.existsSync(path.join(installed, "assets", "intermediate.txt")), false);
	assert.equal(fs.existsSync(path.join(installed, "assets", "old.txt")), false);
	assert.equal(fs.readFileSync(path.join(installed, "data", "keep.txt"), "utf8"), "safe");
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
});

test("unsafe destination symlinks fail closed and do not write outside package", t => {
	const f = fixture(t); const source = f.plugin(); f.install();
	const installed = path.join(f.plugins, "official");
	const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
	fs.rmSync(path.join(installed, "assets"), { recursive: true });
	fs.symlinkSync(outside, path.join(installed, "assets"));
	fs.writeFileSync(path.join(source, "assets", "new.txt"), "new");
	assert.match(f.install().errors.official!, /Unsafe plugin directory/);
	assert.deepEqual(fs.readdirSync(outside), []);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), ["official"]);
});

test("corrupt/future ownership or journal metadata is never silently replaced", t => {
	const f = fixture(t); f.plugin(); f.install();
	const filename = path.join(f.root, "plugins-bundled.json");
	for (const value of ["{broken", '{"version":2,"plugins":{}}', '{"version":1,"plugins":{"official":{"files":["data/private"]}}}']) {
		fs.writeFileSync(filename, value); assert.throws(f.install);
		assert.equal(fs.readFileSync(filename, "utf8"), value);
	}
	fs.writeFileSync(filename, '{"version":1,"plugins":{}}');
	const marker = path.join(f.root, "plugins-installing", "official.json");
	fs.writeFileSync(marker, '{"version":9}');
	assert.match(f.install().errors.official!, /Invalid installation marker/);
	assert.equal(fs.readFileSync(marker, "utf8"), '{"version":9}');
});

test("failed bundled validation blocks old and absent packages while good bundled and external backends remain usable", async t => {
	const f = fixture(t);
	const badSource = f.plugin("bad");
	const sentinel = path.join(f.root, "bad-code-executed");
	const manifestPath = path.join(badSource, "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.backend = "backend.cjs";
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	fs.writeFileSync(path.join(badSource, "backend.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'must not run'); exports.activate = ctx => ctx.handle('proof', () => 1);`);
	assert.equal(Object.keys(f.install().errors).length, 0);
	fs.mkdirSync(path.join(badSource, "data")); // Invalid update; old installed manifest remains valid.
	const fresh = f.plugin("fresh-bad"); fs.writeFileSync(path.join(fresh, ".env"), "reserved");
	const good = f.plugin("good");
	const goodManifest = JSON.parse(fs.readFileSync(path.join(good, "manifest.json"), "utf8"));
	goodManifest.backend = "backend.cjs";
	fs.writeFileSync(path.join(good, "manifest.json"), JSON.stringify(goodManifest));
	fs.writeFileSync(path.join(good, "backend.cjs"), `exports.activate = ctx => { ctx.handle('proof', input => input); };`);
	const external = path.join(f.plugins, "external"); fs.mkdirSync(external);
	fs.writeFileSync(path.join(external, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "external", name: "External", version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs" }));
	fs.writeFileSync(path.join(external, "backend.cjs"), `exports.activate = ctx => { ctx.handle('proof', input => input); };`);
	const report = f.install();
	assert.deepEqual(Object.keys(report.errors).sort(), ["bad", "fresh-bad"]);
	assert.equal(fs.existsSync(path.join(f.plugins, "fresh-bad")), false);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []); // Validation failed before any mutation/journal.
	fs.writeFileSync(path.join(f.root, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { bad: true, "fresh-bad": true, good: true, external: true } }));
	const host = createPluginHost({
		directory: f.plugins, appVersion: "0.3.7", installationErrors: report.errors,
		createServices: () => ({ learning: {} as PluginLearningData, inference: {} as PluginInference, agents: { dispose: async () => {} } as PluginAgentService, workers: { dispose: async () => {} } as PluginWorkerService, createBackgroundTool() { throw new Error("Unexpected background tool in installer fixture"); } }),
	});
	t.after(() => host.dispose()); await host.initialize();
	assert.equal(host.list().length, 4);
	assert.equal(fs.existsSync(sentinel), false);
	for (const id of ["bad", "fresh-bad"]) {
		assert.equal(host.list().find(p => p.id === id)!.status, "error");
		assert.match(host.list().find(p => p.id === id)!.error!, /Plugin startup failed/);
		await assert.rejects(host.call(id, "proof"), /unavailable/);
		await host.setEnabled(id, true);
		assert.equal(host.list().find(p => p.id === id)!.status, "error");
	}
	for (const id of ["good", "external"]) {
		assert.equal(host.list().find(p => p.id === id)!.status, "active");
		assert.equal(await host.call(id, "proof", "usable"), "usable");
	}
	assert.equal(fs.existsSync(sentinel), false);
});

test("a mutation failure is reported without stopping the next bundled package", async t => {
	const f = fixture(t); f.plugin(); f.plugin("z-good");
	const report = interruptRename(t, path.join(f.plugins, "official", "manifest.json"), f.install);
	assert.deepEqual(Object.keys(report.errors), ["official"]);
	assert.equal(fs.existsSync(path.join(f.plugins, "z-good", "manifest.json")), true);
	const host = f.host(report.errors); await host.initialize();
	assert.equal(host.list().find(p => p.id === "official")!.status, "error");
	await host.setEnabled("z-good", true);
	assert.equal(host.list().find(p => p.id === "z-good")!.status, "active");
});

test("missing source for an incomplete package is a scoped error and does not prevent other installs", async t => {
	const f = fixture(t); const source = f.plugin();
	interruptRename(t, path.join(f.plugins, "official", "manifest.json"), f.install);
	fs.rmSync(source, { recursive: true }); f.plugin("good");
	const report = f.install();
	assert.match(report.errors.official!, /no source package to retry/);
	assert.equal(fs.existsSync(path.join(f.plugins, "good", "manifest.json")), true);
	const host = f.host(report.errors); await host.initialize();
	assert.equal(host.list().find(p => p.id === "good")!.status, "disabled");
	assert.equal(host.list().find(p => p.id === "official")!.status, "error");
	await host.setEnabled("good", true);
	assert.equal(host.list().find(p => p.id === "good")!.status, "active");
});

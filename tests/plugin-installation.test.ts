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
	return { root, source, plugins, plugin, host, code: (id = "official") => path.join(plugins, id, "dist"), install: () => installBundledPlugins(source, plugins, "0.3.7") };
}

test("bundled installation requires a dist code root while distribution sources stay flat", t => {
	const f = fixture(t); const shipped = f.plugin();
	assert.deepEqual(Object.keys(f.install().errors), []);
	assert.equal(fs.readFileSync(path.join(f.code(), "main.js"), "utf8"), "export const version = 1");
	assert.equal(fs.existsSync(path.join(f.code(), "manifest.json")), true);
	assert.equal(fs.existsSync(path.join(f.code(), "assets", "old.txt")), true);
	assert.equal(fs.existsSync(path.join(shipped, "manifest.json")), true);
	assert.equal(fs.existsSync(path.join(shipped, "dist")), false, "bundled source is already a flat built artifact");
	for (const file of ["manifest.json", "main.js", "style.css", "assets", "data"]) assert.equal(fs.existsSync(path.join(f.plugins, "official", file)), false, file);
	assert.equal(fs.existsSync(path.join(f.code(), "data")), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "plugins-bundled.json"), "utf8")).plugins.official.files, ["assets/old.txt", "main.js", "manifest.json", "style.css"], "ownership paths are relative to dist, not the project root");
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
});

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
	const installed = f.code(), data = path.join(f.plugins, "official", "data");
	const metadata = path.join(f.root, "plugins-bundled.json");
	const first = fs.readFileSync(metadata, "utf8"); f.install();
	assert.equal(fs.readFileSync(metadata, "utf8"), first);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
	assert.equal(fs.existsSync(data), false);
	assert.equal(fs.existsSync(path.join(installed, "data")), false);
	const host = f.host(); await host.initialize();
	assert.equal(host.list()[0]!.status, "disabled");
	fs.mkdirSync(data);
	fs.writeFileSync(path.join(data, "records.json"), '{"valuable":true}');
	fs.writeFileSync(path.join(installed, "assets", "personal.txt"), "not owned");
	fs.unlinkSync(path.join(shipped, "assets", "old.txt"));
	fs.writeFileSync(path.join(shipped, "assets", "new.txt"), "new");
	fs.writeFileSync(path.join(shipped, "main.js"), "export const version = 2");
	f.install();
	assert.equal(fs.readFileSync(path.join(data, "records.json"), "utf8"), '{"valuable":true}');
	assert.equal(fs.existsSync(path.join(installed, "data")), false);
	assert.equal(fs.readFileSync(path.join(installed, "assets", "personal.txt"), "utf8"), "not owned");
	assert.equal(fs.existsSync(path.join(installed, "assets", "old.txt")), false);
	assert.equal(fs.readFileSync(path.join(installed, "assets", "new.txt"), "utf8"), "new");
	assert.equal(fs.readFileSync(path.join(installed, "main.js"), "utf8"), "export const version = 2");
	await host.refresh(); assert.match(host.list()[0]!.error!, /Restart required/);
});

test("owned updates preserve source and project files at the plugin root plus sibling persistent data", t => {
	const f = fixture(t); const shipped = f.plugin(); assert.deepEqual(Object.keys(f.install().errors), []);
	const pluginRoot = path.join(f.plugins, "official");
	const projectFiles = {
		"package.json": '{"scripts":{"build":"custom source build"}}',
		"src/main.ts": "export const localSource = true;",
		"main.js": "local project source, not installed code",
		"manifest.json": "project manifest is not a runtime manifest",
		"assets/old.txt": "local source asset shares an obsolete owned code path",
		"data/records.json": '{"valuable":true}',
		"data/nested/keep.txt": "persistent nested data",
	};
	for (const [file, bytes] of Object.entries(projectFiles)) {
		fs.mkdirSync(path.dirname(path.join(pluginRoot, file)), { recursive: true }); fs.writeFileSync(path.join(pluginRoot, file), bytes);
	}
	fs.unlinkSync(path.join(shipped, "assets", "old.txt"));
	fs.writeFileSync(path.join(shipped, "main.js"), "export const version = 2");
	fs.writeFileSync(path.join(shipped, "assets", "new.txt"), "new built asset");
	assert.deepEqual(Object.keys(f.install().errors), []);
	for (const [file, bytes] of Object.entries(projectFiles)) assert.equal(fs.readFileSync(path.join(pluginRoot, file), "utf8"), bytes, file);
	assert.equal(fs.readFileSync(path.join(f.code(), "main.js"), "utf8"), "export const version = 2");
	assert.equal(fs.existsSync(path.join(f.code(), "assets", "old.txt")), false);
	assert.equal(fs.readFileSync(path.join(f.code(), "assets", "new.txt"), "utf8"), "new built asset");
	assert.equal(fs.existsSync(path.join(f.code(), "data")), false);
	assert.equal(fs.existsSync(path.join(f.code(), "src")), false);
	assert.equal(fs.existsSync(path.join(f.code(), "package.json")), false);
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
	const existing = f.code(); fs.mkdirSync(existing, { recursive: true });
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
		fs.mkdirSync(f.code("constructor"));
		fs.writeFileSync(path.join(f.code("constructor"), "manifest.json"), "external manifest");
		fs.writeFileSync(path.join(f.code("constructor"), "main.js"), "external code");
		fs.writeFileSync(path.join(existing, "data", "keep.json"), '{"valuable":true}');
		const report = f.install();
		assert.equal(Object.hasOwn(report.errors, "constructor"), true, metadata);
		const id: string = "constructor";
		assert.match(report.errors[id]!, /collides with an external/, metadata);
		assert.equal(fs.readFileSync(path.join(f.code("constructor"), "manifest.json"), "utf8"), "external manifest", metadata);
		assert.equal(fs.readFileSync(path.join(f.code("constructor"), "main.js"), "utf8"), "external code", metadata);
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
	interruptRename(t, path.join(f.code(), "manifest.json"), f.install);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), ["official"]);
	assert.equal(fs.existsSync(path.join(f.code(), "manifest.json")), false);
	const blocked = f.host(); await blocked.initialize();
	assert.equal(blocked.list()[0]!.status, "error");
	assert.match(blocked.list()[0]!.error!, /incomplete/);
	f.install(); assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
	const fresh = f.host(); await fresh.initialize();
	assert.equal(fresh.list()[0]!.status, "disabled");
});

test("an installation marker blocks backend evaluation from dist until recovery and runtime data stays its sibling", async t => {
	const f = fixture(t); const shipped = f.plugin(); const sentinel = path.join(f.root, "backend-evaluated");
	const manifestFile = path.join(shipped, "manifest.json"); const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	manifest.backend = "backend.cjs"; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
	const backend = (value: string) => `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(value)}); exports.activate = ctx => { ctx.handle('proof', () => 'ready'); };`;
	fs.writeFileSync(path.join(shipped, "backend.cjs"), backend("old")); assert.deepEqual(Object.keys(f.install().errors), []);
	fs.writeFileSync(path.join(f.root, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { official: true } }));
	fs.writeFileSync(path.join(shipped, "backend.cjs"), backend("recovered"));
	interruptRename(t, path.join(f.code(), "manifest.json"), f.install);
	assert.equal(fs.existsSync(path.join(f.code(), "manifest.json")), true, "the old valid manifest cannot bypass the marker");
	assert.equal(fs.readFileSync(path.join(f.code(), "backend.cjs"), "utf8"), backend("recovered"));
	const marker = JSON.parse(fs.readFileSync(path.join(f.root, "plugins-installing", "official.json"), "utf8"));
	assert.ok(marker.files.includes("backend.cjs")); assert.equal(marker.files.some((file: string) => file.startsWith("dist/")), false);
	let serviceCalls = 0;
	const host = () => {
		const h = createPluginHost({
			directory: f.plugins, appVersion: "0.3.7",
			createServices({ dataDirectory }) {
				serviceCalls++; assert.equal(dataDirectory, path.join(f.plugins, "official", "data"));
				return { learning: {} as PluginLearningData, inference: {} as PluginInference, agents: { dispose: async () => {} } as PluginAgentService, workers: { dispose: async () => {} } as PluginWorkerService, createBackgroundTool() { throw new Error("Unexpected background tool in installer fixture"); } };
			},
		});
		t.after(() => h.dispose()); return h;
	};
	const blocked = host(); await blocked.initialize();
	assert.equal(blocked.list()[0]!.status, "error"); assert.match(blocked.list()[0]!.error!, /incomplete/);
	assert.equal(serviceCalls, 0); assert.equal(fs.existsSync(sentinel), false);
	await assert.rejects(blocked.call("official", "proof"), /unavailable/);
	assert.deepEqual(Object.keys(f.install().errors), []); assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
	const recovered = host(); await recovered.initialize();
	assert.equal(recovered.list()[0]!.status, "active"); assert.equal(await recovered.call("official", "proof"), "ready");
	assert.equal(fs.readFileSync(sentinel, "utf8"), "recovered"); assert.equal(serviceCalls, 1);
	assert.equal(fs.existsSync(path.join(f.plugins, "official", "data")), true);
	assert.equal(fs.existsSync(path.join(f.code(), "data")), false);
});

test("interrupted update preserves data; retry cleans union of old, intermediate and latest owned assets", async t => {
	const f = fixture(t); const source = f.plugin(); f.install();
	const installed = f.code(), data = path.join(f.plugins, "official", "data");
	fs.mkdirSync(data); fs.writeFileSync(path.join(data, "keep.txt"), "safe");
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
	assert.equal(fs.readFileSync(path.join(data, "keep.txt"), "utf8"), "safe");
	assert.equal(fs.existsSync(path.join(installed, "data")), false);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), []);
});

test("unsafe destination symlinks fail closed and do not write outside package", t => {
	const f = fixture(t); const source = f.plugin(); f.install();
	const installed = f.code();
	const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
	fs.rmSync(path.join(installed, "assets"), { recursive: true });
	fs.symlinkSync(outside, path.join(installed, "assets"));
	fs.writeFileSync(path.join(source, "assets", "new.txt"), "new");
	assert.match(f.install().errors.official!, /Unsafe plugin directory/);
	assert.deepEqual(fs.readdirSync(outside), []);
	assert.deepEqual(pendingBundledPluginIds(f.plugins), ["official"]);
});

test("symlinked plugin roots and dist directories cannot redirect owned installation writes", t => {
	for (const target of ["plugin-root", "dist"] as const) {
		const f = fixture(t); const shipped = f.plugin(); assert.deepEqual(Object.keys(f.install().errors), []);
		const outside = path.join(f.root, "outside"); fs.mkdirSync(path.join(outside, "dist"), { recursive: true });
		fs.writeFileSync(path.join(outside, "main.js"), "outside code"); fs.writeFileSync(path.join(outside, "dist", "main.js"), "outside nested code");
		const before = fs.readdirSync(outside, { recursive: true }).sort();
		const link = target === "plugin-root" ? path.join(f.plugins, "official") : f.code();
		fs.rmSync(link, { recursive: true }); fs.symlinkSync(outside, link, "dir");
		fs.writeFileSync(path.join(shipped, "main.js"), "new installed code");
		fs.writeFileSync(path.join(shipped, "assets", "new.txt"), "new asset");
		assert.match(f.install().errors.official!, /Unsafe (?:installed package|plugin directory)/, target);
		assert.deepEqual(fs.readdirSync(outside, { recursive: true }).sort(), before, target);
		assert.equal(fs.readFileSync(path.join(outside, "main.js"), "utf8"), "outside code", target);
		assert.equal(fs.readFileSync(path.join(outside, "dist", "main.js"), "utf8"), "outside nested code", target);
		assert.equal(fs.lstatSync(link).isSymbolicLink(), true, target);
	}
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
	const external = f.code("external"); fs.mkdirSync(external, { recursive: true });
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
	const report = interruptRename(t, path.join(f.code(), "manifest.json"), f.install);
	assert.deepEqual(Object.keys(report.errors), ["official"]);
	assert.equal(fs.existsSync(path.join(f.code("z-good"), "manifest.json")), true);
	const host = f.host(report.errors); await host.initialize();
	assert.equal(host.list().find(p => p.id === "official")!.status, "error");
	await host.setEnabled("z-good", true);
	assert.equal(host.list().find(p => p.id === "z-good")!.status, "active");
});

test("missing source for an incomplete package is a scoped error and does not prevent other installs", async t => {
	const f = fixture(t); const source = f.plugin();
	interruptRename(t, path.join(f.code(), "manifest.json"), f.install);
	fs.rmSync(source, { recursive: true }); f.plugin("good");
	const report = f.install();
	assert.match(report.errors.official!, /no source package to retry/);
	assert.equal(fs.existsSync(path.join(f.code("good"), "manifest.json")), true);
	const host = f.host(report.errors); await host.initialize();
	assert.equal(host.list().find(p => p.id === "good")!.status, "disabled");
	assert.equal(host.list().find(p => p.id === "official")!.status, "error");
	await host.setEnabled("good", true);
	assert.equal(host.list().find(p => p.id === "good")!.status, "active");
});

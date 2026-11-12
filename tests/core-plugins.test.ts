import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { createPluginHost, type PluginHostDependencies } from "../src/server/plugin-host.ts";
import type { PluginBackendContext } from "../src/core/plugins.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-core-host-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const directory = path.join(root, "data", "plugins");
	const core = { directory: path.join(root, "app", "core-plugins"), dataDirectory: path.join(root, "data", "core-plugin-data"), ids: ["official", "missing"] };
	const deps: PluginHostDependencies = { directory, core, appVersion: "0.4.1", createServices() {
		return { agents: { dispose() {} }, workers: { dispose() {} } } as unknown as ReturnType<PluginHostDependencies["createServices"]>;
	} };
	function pkg(id: string, origin: "core" | "community", backend = "exports.activate = ctx => { ctx.handle('context', () => ctx); };") {
		const code = origin === "core" ? path.join(core.directory, id) : path.join(directory, id, "dist");
		fs.mkdirSync(code, { recursive: true });
		fs.writeFileSync(path.join(code, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", backend: "backend.cjs", main: "main.js", origin: "core" }));
		fs.writeFileSync(path.join(code, "backend.cjs"), backend);
		fs.writeFileSync(path.join(code, "main.js"), "export function activate() {}");
		return code;
	}
	const host = createPluginHost(deps); t.after(() => host.dispose());
	return { root, directory, core, deps, pkg, host };
}

test("core packages load directly, default disabled, and never create data or evaluate disabled code", async t => {
	const f = fixture(t); const code = f.pkg("official", "core", "throw Error('disabled code evaluated')");
	f.pkg("community", "community");
	await f.host.initialize();
	assert.deepEqual(f.host.list().map(p => [p.id, p.origin, p.enabled, p.status]), [["community", "community", false, "disabled"], ["missing", "core", false, "error"], ["official", "core", false, "disabled"]]);
	assert.equal(fs.existsSync(f.core.dataDirectory), false);
	assert.equal(fs.existsSync(path.join(code, "data")), false);
	assert.equal(fs.existsSync(path.join(f.directory, "official")), false, "no core installation copy");
});

test("core activation uses separate writable data, pinned assets, and persisted explicit choices", async t => {
	const f = fixture(t); const code = f.pkg("official", "core"); f.pkg("community", "community");
	const before = fs.readdirSync(code).map(name => [name, fs.readFileSync(path.join(code, name), "utf8")]);
	await f.host.initialize(); await f.host.setEnabled("official", true); await f.host.setEnabled("community", true);
	const ctx = await f.host.call("official", "context") as PluginBackendContext;
	assert.equal(ctx.directory, code); assert.equal(ctx.dataDirectory, path.join(f.core.dataDirectory, "official"));
	const community = await f.host.call("community", "context") as PluginBackendContext;
	assert.equal(community.dataDirectory, path.join(f.directory, "community", "data"));
	fs.writeFileSync(path.join(ctx.dataDirectory, "private.json"), "private");
	assert.throws(() => f.host.asset("official", ["data", "private.json"]));
	assert.throws(() => f.host.asset("official", ["backend.cjs"]));
	assert.match(Buffer.from(f.host.asset("official", ["main.js"]).bytes).toString(), /activate/);
	assert.deepEqual(fs.readdirSync(code).map(name => [name, fs.readFileSync(path.join(code, name), "utf8")]), before);
	fs.writeFileSync(path.join(code, "main.js"), "export const changed = true;");
	await f.host.refresh(); assert.match(f.host.list().find(p => p.id === "official")!.error!, /Restart required/);
	assert.doesNotMatch(Buffer.from(f.host.asset("official", ["main.js"]).bytes).toString(), /changed/);
	await f.host.setEnabled("official", false); await f.host.dispose();
	const restarted = createPluginHost(f.deps); t.after(() => restarted.dispose()); await restarted.initialize();
	assert.equal(restarted.list().find(p => p.id === "official")!.enabled, false);
	assert.equal(restarted.list().find(p => p.id === "community")!.enabled, true);
});

test("reserved IDs cannot be shadowed even with missing/invalid core code; conflicts never poison core activation", async t => {
	const f = fixture(t); f.pkg("official", "core"); f.pkg("official", "community", "throw Error('shadow code evaluated')");
	f.pkg("missing", "community", "throw Error('missing core fallback evaluated')");
	await f.host.initialize(); await f.host.setEnabled("official", true); await f.host.setEnabled("missing", true);
	assert.equal(f.host.list().find(p => p.id === "official")!.status, "active");
	assert.equal(f.host.list().find(p => p.id === "missing")!.status, "error");
	assert.deepEqual(f.host.conflicts().map(p => p.id), ["missing", "official"]);
	assert.ok(f.host.conflicts().every(p => /reserved/i.test(p.error)));
	assert.equal(fs.existsSync(path.join(f.directory, "official", "dist", "backend.cjs")), true);
	assert.equal(fs.existsSync(path.join(f.directory, "official", "data")), false);
	fs.rmSync(path.join(f.directory, "official"), { recursive: true }); await f.host.refresh();
	assert.deepEqual(f.host.conflicts().map(p => p.id), ["missing"]);
});

test("core provenance/configuration is captured, and replacing the core root with a symlink revokes assets", async t => {
	const f = fixture(t); const code = f.pkg("official", "core"), data = f.core.dataDirectory, root = f.core.directory;
	f.core.ids.splice(0, f.core.ids.length, "impostor"); f.core.directory = path.join(f.root, "wrong-code"); f.core.dataDirectory = path.join(f.root, "wrong-data");
	await f.host.initialize(); await f.host.setEnabled("official", true);
	const ctx = await f.host.call("official", "context") as PluginBackendContext;
	assert.equal(ctx.directory, code); assert.equal(ctx.dataDirectory, path.join(data, "official"));
	assert.equal(f.host.list().find(p => p.id === "official")!.origin, "core");
	const moved = path.join(f.root, "moved-code"); fs.renameSync(root, moved); fs.symlinkSync(moved, root);
	assert.throws(() => f.host.asset("official", ["main.js"]), /unsafe plugin asset/);
});

test("core data and package symlinks fail closed without writing their targets", async t => {
	for (const kind of ["package", "data-root", "data-id"] as const) {
		const f = fixture(t); const code = f.pkg("official", "core"); const outside = path.join(f.root, `outside-${kind}`); fs.mkdirSync(outside);
		if (kind === "package") { fs.rmSync(code, { recursive: true }); fs.symlinkSync(outside, code); }
		else if (kind === "data-root") { fs.mkdirSync(path.dirname(f.core.dataDirectory), { recursive: true }); fs.symlinkSync(outside, f.core.dataDirectory); }
		else { fs.mkdirSync(f.core.dataDirectory, { recursive: true }); fs.symlinkSync(outside, path.join(f.core.dataDirectory, "official")); }
		await f.host.initialize(); await f.host.setEnabled("official", true);
		assert.equal(f.host.list().find(p => p.id === "official")!.status, "error", kind);
		assert.deepEqual(fs.readdirSync(outside), [], kind);
	}
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it, mock } from "node:test";
import { installPluginLocal } from "../scripts/install-plugin-local.mjs";
import { parsePluginManifest } from "../src/core/plugins.ts";

const helper = path.resolve(import.meta.dirname, "../scripts/install-plugin-local.mjs");
function fixture(run: (f: { root: string; project: string; directory: string; installed: string; write: (name: string, data: string) => void; manifest: Record<string, unknown> }) => void) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-install-local-")));
	const project = path.join(root, "source project"), directory = path.join(root, "app profile", "plugins"), installed = path.join(directory, "test-plugin");
	const write = (name: string, data: string) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
	const manifest = { apiVersion: 1, id: "test-plugin", name: "Test plugin", version: "1.0.0", minAppVersion: "0.5.0", main: "main.js" };
	try {
		write("source project/dist/manifest.json", JSON.stringify(manifest));
		write("source project/dist/main.js", "export function activate() {};");
		write("source project/dist/assets/chunk.js", "new asset");
		write("source project/data/private.json", "source data");
		write("source project/src/main.ts", "not installed");
		write("app profile/plugins/test-plugin/dist/main.js", "old code");
		write("app profile/plugins/test-plugin/dist/stale.js", "stale asset");
		write("app profile/plugins/test-plugin/data/private.json", "installed data");
		write("app profile/plugins/test-plugin/src/main.ts", "installed source");
		write("app profile/plugins/other-plugin/data/keep.json", "other data");
		run({ root, project, directory, installed, write, manifest });
	} finally { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
}
function unchanged(installed: string) {
	assert.equal(fs.readFileSync(path.join(installed, "dist/main.js"), "utf8"), "old code");
	assert.equal(fs.readFileSync(path.join(installed, "data/private.json"), "utf8"), "installed data");
	assert.equal(fs.readFileSync(path.join(installed, "src/main.ts"), "utf8"), "installed source");
	assert.deepEqual(fs.readdirSync(installed).sort(), ["data", "dist", "src"]);
}

it("replaces only built dist, removes stale assets, preserves all sibling data/source and supports repeated installs", () => fixture(({ project, directory, installed }) => {
	for (let count = 0; count < 2; count++) {
		assert.deepEqual(installPluginLocal({ project, pluginsDirectory: directory }), { id: "test-plugin", directory: path.join(installed, "dist"), copied: true });
		assert.equal(fs.existsSync(path.join(installed, "dist/stale.js")), false);
		assert.equal(fs.readFileSync(path.join(installed, "dist/assets/chunk.js"), "utf8"), "new asset");
		assert.equal(fs.readFileSync(path.join(installed, "data/private.json"), "utf8"), "installed data");
		assert.equal(fs.readFileSync(path.join(installed, "src/main.ts"), "utf8"), "installed source");
		assert.equal(fs.readFileSync(path.join(directory, "other-plugin/data/keep.json"), "utf8"), "other data");
		assert.deepEqual(fs.readdirSync(installed).sort(), ["data", "dist", "src"]);
	}
}));
it("creates a new plugin folder without installing source or changing enablement", () => fixture(({ project, directory, installed }) => {
	fs.rmSync(installed, { recursive: true });
	fs.writeFileSync(path.join(directory, "plugins-state.json"), "state sentinel");
	installPluginLocal({ project, pluginsDirectory: directory });
	assert.deepEqual(fs.readdirSync(installed), ["dist"]);
	assert.equal(fs.readFileSync(path.join(directory, "plugins-state.json"), "utf8"), "state sentinel");
}));
it("recognizes an in-place build without copying or removing anything", () => fixture(({ project, write }) => {
	const parent = path.dirname(project), correctName = path.join(parent, "test-plugin");
	fs.renameSync(project, correctName);
	write("test-plugin/data/keep.json", "in-place data");
	assert.deepEqual(installPluginLocal({ project: correctName, pluginsDirectory: parent }), { id: "test-plugin", directory: path.join(correctName, "dist"), copied: false });
	assert.equal(fs.readFileSync(path.join(correctName, "data/keep.json"), "utf8"), "in-place data");
}));
it("requires an explicit existing directory and rejects overlapping dist paths", () => fixture(({ project, directory, installed, manifest }) => {
	for (const input of ["", " ", path.join(directory, "missing")]) assert.throws(() => installPluginLocal({ project, pluginsDirectory: input }));
	fs.writeFileSync(path.join(project, "dist/manifest.json"), JSON.stringify({ ...manifest, id: "dist" }));
	assert.throws(() => installPluginLocal({ project, pluginsDirectory: project }), /overlapping/);
	unchanged(installed);
}));
it("refuses malformed manifests and missing entries before touching installed code", () => {
	for (const patch of [{ id: "../escape" }, { id: "Upper" }, { apiVersion: 2 }, { name: "" }, { version: "01.0.0" }, { minAppVersion: "current" }, { main: "../main.js" }, { main: "missing.js" }, { main: "main.cjs" }, { main: null }, { main: undefined }, { backend: "main.js" }, { styles: "style.css" }, { author: 4 }]) fixture(({ project, directory, installed, manifest }) => {
		fs.writeFileSync(path.join(project, "dist/manifest.json"), JSON.stringify({ ...manifest, ...patch }));
		assert.throws(() => installPluginLocal({ project, pluginsDirectory: directory }));
		unchanged(installed);
	});
});
it("checks portable manifest structural rules against the host contract", () => fixture(({ project, directory, manifest }) => {
	for (const patch of [{}, { backend: "backend.cjs", main: undefined }, { description: "Example", author: "Author" }, { styles: "styles.css" }]) {
		const current = { ...manifest, ...patch };
		parsePluginManifest(current, "test-plugin", "0.5.0");
		fs.writeFileSync(path.join(project, "dist/manifest.json"), JSON.stringify(current));
		fs.writeFileSync(path.join(project, "dist/backend.cjs"), "exports.activate = () => {};");
		fs.writeFileSync(path.join(project, "dist/styles.css"), "body {}");
		installPluginLocal({ project, pluginsDirectory: directory });
	}
}));
it("refuses non-distributable contents, file and directory symlinks, including manifest and root links", () => {
	for (const mode of ["data", "nested-data", "credentials", "manifest-link", "asset-link", "asset-parent-link", "dist-link", "project-link", "directory-link"]) fixture(({ root, project, directory, installed, write }) => {
		if (mode === "data") write("source project/dist/data/private.json", "private");
		if (mode === "nested-data") write("source project/dist/assets/data/private.json", "private");
		if (mode === "credentials") write("source project/dist/assets/.env.local", "private");
		if (["manifest-link", "asset-link", "asset-parent-link", "dist-link"].includes(mode)) {
			const entry = mode === "manifest-link" ? "manifest.json" : mode === "asset-link" ? "assets/chunk.js" : mode === "asset-parent-link" ? "assets" : "";
			const source = path.join(project, "dist", entry), target = path.join(root, "external");
			fs.renameSync(source, target); fs.symlinkSync(target, source, fs.statSync(target).isDirectory() ? "dir" : "file");
		}
		let source = project, target = directory;
		if (mode === "project-link") { source = path.join(root, "project-link"); fs.symlinkSync(project, source, "dir"); }
		if (mode === "directory-link") { target = path.join(root, "directory-link"); fs.symlinkSync(directory, target, "dir"); }
		assert.throws(() => installPluginLocal({ project: source, pluginsDirectory: target }), /Refusing/);
		unchanged(installed);
	});
});
it("refuses linked target plugin/dist and misplaced target dist/data, even dangling links", () => {
	for (const mode of ["plugin", "dist", "data", "dangling-data"]) fixture(({ root, project, directory, installed }) => {
		const source = mode === "plugin" ? installed : mode === "dist" ? path.join(installed, "dist") : path.join(installed, "dist/data");
		const external = path.join(root, "external");
		if (mode === "plugin" || mode === "dist") { fs.renameSync(source, external); fs.symlinkSync(external, source, "dir"); }
		else if (mode === "data") fs.mkdirSync(source);
		else fs.symlinkSync(external, source, "dir");
		assert.throws(() => installPluginLocal({ project, pluginsDirectory: directory }), /Refusing/);
		assert.equal(fs.readFileSync(path.join(installed, "dist/main.js"), "utf8"), "old code");
		assert.equal(fs.readFileSync(path.join(installed, "data/private.json"), "utf8"), "installed data");
	});
});
it("copy failures do not touch installed code and clean up staging", () => fixture(({ project, directory, installed }) => {
	mock.method(fs, "copyFileSync", () => { throw Error("synthetic copy failure"); });
	assert.throws(() => installPluginLocal({ project, pluginsDirectory: directory }), /copy failure/);
	unchanged(installed);
}));
it("failed replacement restores the original dist and cleans up staging", () => fixture(({ project, directory, installed }) => {
	const rename = fs.renameSync;
	mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
		if (String(source).endsWith(`${path.sep}next`)) throw Error("synthetic replacement failure");
		return rename(source, destination);
	});
	assert.throws(() => installPluginLocal({ project, pluginsDirectory: directory }), /replacement failure/);
	unchanged(installed);
}));
it("if rollback itself fails, retains and reports the previous dist backup rather than deleting it", () => fixture(({ project, directory, installed }) => {
	const rename = fs.renameSync;
	mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
		if (String(source).endsWith(`${path.sep}next`) || String(source).endsWith(`${path.sep}previous`)) throw Error("synthetic rename failure");
		return rename(source, destination);
	});
	assert.throws(() => installPluginLocal({ project, pluginsDirectory: directory }), /Previous dist preserved at/);
	const stage = fs.readdirSync(installed).find(name => name.startsWith(".install-"))!;
	assert.equal(fs.readFileSync(path.join(installed, stage, "previous/main.js"), "utf8"), "old code");
	assert.equal(fs.readFileSync(path.join(installed, "data/private.json"), "utf8"), "installed data");
}));
it("the documented npm command builds and installs without a checkout, and build failure prevents installation", () => fixture(({ root, project, directory, installed, write }) => {
	fs.mkdirSync(path.join(project, "scripts")); fs.copyFileSync(helper, path.join(project, "scripts/install-plugin-local.mjs"));
	write("source project/package.json", JSON.stringify({ private: true, scripts: { build: 'node -e "process.exit(Number(process.env.FAIL_BUILD || 0))"', "install:local": "npm run build && node scripts/install-plugin-local.mjs" } }));
	const npm = process.env.npm_execpath;
	assert.ok(npm, "test must run under npm");
	const execute = (fail: string) => spawnSync(process.execPath, [npm, "run", "install:local", "--", directory], { cwd: project, encoding: "utf8", env: { ...process.env, HOME: root, FAIL_BUILD: fail } });
	const failed = execute("1"); assert.equal(failed.status, 1, failed.stderr); unchanged(installed);
	const success = execute("0"); assert.equal(success.status, 0, success.stderr);
	assert.match(success.stdout, /Installed:/);
	assert.equal(fs.readFileSync(path.join(installed, "dist/assets/chunk.js"), "utf8"), "new asset");
	assert.equal(fs.readFileSync(path.join(installed, "data/private.json"), "utf8"), "installed data");
	const missing = spawnSync(process.execPath, [helper], { cwd: project, encoding: "utf8" });
	assert.equal(missing.status, 1); assert.match(missing.stderr, /Usage:/);
}));

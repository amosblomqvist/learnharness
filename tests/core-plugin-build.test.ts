import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildCorePlugins, validateCorePackages } from "../scripts/build-core-plugins.mjs";

function fixture(run: (root: string, calls: string[]) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-core-build-"));
	try {
		fs.writeFileSync(path.join(root, "core-plugins.json"), JSON.stringify(["one", "two"]));
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.4.1" }));
		for (const id of ["one", "two", "ui-showcase"]) {
			const code = path.join(root, "plugins", id, "dist"); fs.mkdirSync(path.join(code, "assets"), { recursive: true });
			fs.writeFileSync(path.join(code, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "main.js" }));
			fs.writeFileSync(path.join(code, "main.js"), "export const bundled = true;");
			fs.writeFileSync(path.join(code, "assets", "font.woff"), "font"); fs.writeFileSync(path.join(code, "LICENSE"), "license");
		}
		run(root, []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("builds only catalog packages deterministically; stages complete distributions, replacing stale extras", () => fixture((root, calls) => {
	fs.mkdirSync(path.join(root, "core-plugins", "stale"), { recursive: true });
	fs.chmodSync(path.join(root, "plugins", "one", "dist"), 0o700);
	fs.chmodSync(path.join(root, "plugins", "one", "dist", "main.js"), 0o600);
	buildCorePlugins(root, { run: (_args: string[], cwd: string) => { calls.push(path.basename(cwd)); } });
	assert.deepEqual(calls, ["one", "two"]);
	const out = path.join(root, "core-plugins"); assert.deepEqual(fs.readdirSync(out), ["one", "two"]);
	assert.equal(fs.readFileSync(path.join(out, "one", "LICENSE"), "utf8"), "license");
	assert.equal(fs.readFileSync(path.join(out, "two", "assets", "font.woff"), "utf8"), "font");
	validateCorePackages(root, out);
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(out).mode & 0o777, 0o755, "mkdtemp's private mode must not ship as app code");
		assert.equal(fs.statSync(path.join(out, "one")).mode & 0o777, 0o755);
		assert.equal(fs.statSync(path.join(out, "one", "main.js")).mode & 0o777, 0o644);
	}
	assert.equal(fs.existsSync(path.join(root, "data")), false);
}));

test("failed builds/validation leave the previous staged tree intact", () => fixture((root) => {
	const out = path.join(root, "core-plugins"); fs.mkdirSync(out); fs.writeFileSync(path.join(out, "previous"), "keep");
	assert.throws(() => buildCorePlugins(root, { run: () => { throw Error("build failed"); } }), /build failed/);
	assert.equal(fs.readFileSync(path.join(out, "previous"), "utf8"), "keep");
	fs.rmSync(path.join(root, "plugins", "two", "dist", "main.js"));
	assert.throws(() => buildCorePlugins(root, { run() {} }), /main\.js/);
	assert.equal(fs.readFileSync(path.join(out, "previous"), "utf8"), "keep");
}));

test("staging rejects data, credentials, source/tooling and symlinks instead of copying them", () => {
	for (const entry of ["data/private.json", "auth.json", ".env", "tests/test.js", "node_modules/x/index.js", "src/main.ts", "linked"]) fixture(root => {
		const code = path.join(root, "plugins", "one", "dist"); const file = path.join(code, entry);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (entry === "linked") fs.symlinkSync(path.join(code, "main.js"), file); else fs.writeFileSync(file, "private");
		assert.throws(() => buildCorePlugins(root, { run() {} }), /Unsafe|Refusing/);
		assert.equal(fs.existsSync(path.join(root, "core-plugins")), false);
	});
});

test("payload validation requires the exact catalog and compatible manifests", () => fixture(root => {
	buildCorePlugins(root, { run() {} }); const out = path.join(root, "core-plugins");
	fs.mkdirSync(path.join(out, "ui-showcase")); assert.throws(() => validateCorePackages(root, out), /catalog/);
	fs.rmSync(path.join(out, "ui-showcase"), { recursive: true });
	fs.rmSync(path.join(out, "one", "manifest.json")); assert.throws(() => validateCorePackages(root, out), /manifest/);
}));

test("all supported development/build entry points stage core packages", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.scripts["plugins:build-core"], "node scripts/build-core-plugins.mjs");
	for (const command of ["dev", "build"]) assert.match(pkg.scripts[command], /npm run plugins:build-core && next /);
	assert.match(pkg.scripts["desktop:dev"], /npm run dev/); assert.match(pkg.scripts["desktop:dist"], /npm run build/);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { setupPlugins } from "../scripts/setup-plugins.mjs";

function fixture(run: (root: string, plugin: (id: string, sdk?: boolean, lock?: boolean) => void) => void) {
	const root = mkdtempSync(path.join(tmpdir(), "lh-plugin-setup-"));
	mkdirSync(path.join(root, "plugins"));
	try {
		run(root, (id, sdk = false, lock = true) => {
			const directory = path.join(root, "plugins", id);
			mkdirSync(directory, { recursive: true });
			writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: sdk ? { sdk: "generate-types" } : {} }));
			if (lock) writeFileSync(path.join(directory, "package-lock.json"), "{}");
		});
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("plugin setup generates SDKs before locked installs in deterministic source-package order", () => {
	fixture((root, plugin) => {
		plugin("z-types", true); plugin("a-javascript");
		mkdirSync(path.join(root, "plugins", "not-a-package"));
		mkdirSync(path.join(root, "data", "plugins", "learner-installation"), { recursive: true });
		const calls: { args: string[]; cwd: string }[] = [];
		setupPlugins(root, { run: (args: string[], cwd: string) => { calls.push({ args, cwd }); } });
		assert.deepEqual(calls, [
			{ args: ["ci"], cwd: path.join(root, "plugins", "a-javascript") },
			{ args: ["run", "sdk"], cwd: path.join(root, "plugins", "z-types") },
			{ args: ["ci"], cwd: path.join(root, "plugins", "z-types") },
		]);
		assert.ok(calls.every(call => !call.args.some(arg => ["build", "install", "test"].includes(arg))), "Setup never builds, copies, enables or runs plugins");
	});
});

test("plugin setup refuses missing lockfiles before starting any installs", () => {
	fixture((root, plugin) => {
		plugin("a-valid", true); plugin("z-unlocked", false, false);
		const calls: unknown[] = [];
		assert.throws(() => setupPlugins(root, { run: (...args: unknown[]) => { calls.push(args); } }), /z-unlocked.*package-lock\.json/);
		assert.deepEqual(calls, []);
	});
});

test("plugin setup stops at a failed SDK generation rather than installing that or later packages", () => {
	fixture((root, plugin) => {
		plugin("a-types", true); plugin("z-later");
		const calls: string[][] = [];
		assert.throws(() => setupPlugins(root, { run: (args: string[]) => { calls.push(args); throw new Error("SDK failed"); } }), /SDK failed/);
		assert.deepEqual(calls, [["run", "sdk"]]);
	});
});

test("plugin setup stops at a failed locked install", () => {
	fixture((root, plugin) => {
		plugin("a-first"); plugin("z-later");
		const calls: string[][] = [];
		assert.throws(() => setupPlugins(root, { run: (args: string[]) => { calls.push(args); throw new Error("Locked install failed"); } }), /Locked install failed/);
		assert.deepEqual(calls, [["ci"]]);
	});
});

test("contributor and CI entry points prepare plugins before typechecking or building", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	assert.equal(pkg.scripts["plugins:setup"], "node scripts/setup-plugins.mjs");
	for (const workflow of ["ci.yml", "release.yml"]) {
		const source = readFileSync(path.join(root, ".github", "workflows", workflow), "utf8");
		for (const section of source.split("- run: npm ci").slice(1)) {
			const gate = /- run: npm run (typecheck|build)/.exec(section);
			if (!gate) continue;
			const setup = section.indexOf("- run: npm run plugins:setup");
			assert.ok(setup >= 0 && setup < gate.index, `${workflow}: clean-checkout gates require plugin setup first`);
		}
	}
	assert.match(readFileSync(path.join(root, "docs", "development.md"), "utf8"), /npm run plugins:setup/);
});

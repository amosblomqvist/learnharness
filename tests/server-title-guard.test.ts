/** Backend title isolation without launching Electron or touching a user profile. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const mainFile = path.join(root, "electron/main.cjs");
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);
const guardSource = readFileSync(path.join(root, "electron/server-title-guard.cjs"), "utf8");
const backendEnv = { ELECTRON_RUN_AS_NODE: "1", LH_DESKTOP_SERVER: "1" };

function titleFixture(platform = "darwin", env: Record<string, string> = backendEnv) {
	const nativeWrites: unknown[] = [];
	let nativeReads = 0;
	const process = { platform, env } as { platform: string; env: Record<string, string>; title: unknown };
	Object.defineProperty(process, "title", {
		configurable: true, enumerable: true,
		get() { nativeReads++; return "initial native title"; },
		set(value) { nativeWrites.push(value); },
	});
	const original = Object.getOwnPropertyDescriptor(process, "title");
	runInNewContext(guardSource, { process });
	return { process, nativeWrites, original, nativeReads: () => nativeReads };
}

describe("macOS backend process.title guard", () => {
	it("reads the initial title once, then isolates strict-mode writes from the native setter", () => {
		const fixture = titleFixture();
		assert.equal(fixture.nativeReads(), 1);
		assert.equal(fixture.process.title, "initial native title");
		runInNewContext('"use strict"; process.title = "next-server (v16.3.2)";', { process: fixture.process });
		assert.equal(fixture.process.title, "next-server (v16.3.2)");
		fixture.process.title = "next-router-worker";
		assert.equal(fixture.process.title, "next-router-worker");
		assert.deepEqual(fixture.nativeWrites, []);
		assert.equal(fixture.nativeReads(), 1);
		const descriptor = Object.getOwnPropertyDescriptor(fixture.process, "title")!;
		assert.equal(typeof descriptor.get, "function");
		assert.equal(typeof descriptor.set, "function");
		assert.equal(descriptor.configurable, true);
		assert.equal(descriptor.enumerable, true);
	});

	it("uses the approved String(value) contract, without native length truncation", () => {
		const fixture = titleFixture();
		for (const value of [42, true, null, undefined, Symbol("title"), "x".repeat(4096)]) {
			fixture.process.title = value;
			assert.equal(fixture.process.title, String(value));
		}
		let coercions = 0;
		fixture.process.title = { toString() { coercions++; return "custom title"; } };
		assert.equal(fixture.process.title, "custom title");
		assert.equal(coercions, 1);
		assert.throws(() => { fixture.process.title = { toString() { throw new Error("conversion failed"); } }; }, /conversion failed/);
		assert.equal(fixture.process.title, "custom title");
		assert.deepEqual(fixture.nativeWrites, []);
	});

	it("can be loaded again without restoring the native accessor", () => {
		const fixture = titleFixture();
		fixture.process.title = "remembered";
		runInNewContext(guardSource, { process: fixture.process });
		assert.equal(fixture.process.title, "remembered");
		fixture.process.title = "next-server";
		assert.deepEqual(fixture.nativeWrites, []);
		assert.equal(fixture.nativeReads(), 1);
	});

	for (const [label, platform, env] of [
		["Windows", "win32", backendEnv],
		["Linux", "linux", backendEnv],
		["full-Electron browser helper", "darwin", {}],
		["non-backend Node child", "darwin", { ELECTRON_RUN_AS_NODE: "1" }],
		["non-Node-mode process", "darwin", { LH_DESKTOP_SERVER: "1" }],
	] as const) {
		it(`leaves the original property untouched for ${label}`, () => {
			const fixture = titleFixture(platform, env);
			assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.process, "title"), fixture.original);
			assert.equal(fixture.nativeReads(), 0);
			assert.deepEqual(fixture.nativeWrites, []);
		});
	}
});

async function serverLaunch(platform: string) {
	let launch!: { binary: string; args: string[]; options: { cwd: string; env: Record<string, string>; stdio: string[] } };
	const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
	const context = {
		require: (id: string) => id === "electron" ? {
			app: { setName() {}, requestSingleInstanceLock: () => false, quit() {}, getPath: () => "/fixture/user-data" },
		} : id === "node:child_process" ? {
			spawn(binary: string, args: string[], options: typeof launch.options) {
				launch = JSON.parse(JSON.stringify({ binary, args, options }));
				return child;
			},
		} : mainRequire(id),
		process: { platform, argv: [], env: { FIXTURE: "kept" }, on() {}, execPath: "/fixture/LearnHarness", resourcesPath: "/fixture/resources with spaces" },
		__dirname: path.dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	await runInNewContext("startServer(54321)", context);
	return launch;
}

describe("backend-only preload wiring and packaging", () => {
	for (const platform of ["darwin", "win32", "linux"]) {
		it(`${platform} uses the real server launch with the intended argument order`, async () => {
			const launch = await serverLaunch(platform);
			const entry = path.join("/fixture/resources with spaces", "server", "standalone", "server.js");
			assert.equal(launch.binary, "/fixture/LearnHarness");
			assert.deepEqual(launch.args, platform === "darwin"
				? ["--require", path.join("/fixture/resources with spaces", "server-title-guard.cjs"), entry]
				: [entry]);
			assert.equal(launch.options.cwd, path.dirname(entry));
			assert.equal(launch.options.env.NODE_OPTIONS, undefined, "do not add NODE_OPTIONS to the child environment");
			assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, "1");
			assert.equal(launch.options.env.LH_DESKTOP_SERVER, "1");
			assert.equal(launch.options.env.LH_DATA_DIR, path.join("/fixture/user-data", "data"));
			assert.equal(launch.options.env.LH_AUTH_FILE, path.join("/fixture/user-data", "auth.json"));
			assert.equal(launch.options.env.PORT, "54321");
			assert.equal(launch.options.env.HOSTNAME, "127.0.0.1");
			assert.equal(launch.options.env.FIXTURE, "kept");
			assert.deepEqual(launch.options.stdio, ["ignore", "pipe", "pipe", "ipc"]);
		});
	}

	it("electron-builder copies the guard outside ASAR only on macOS, retaining shared resources", async () => {
		const yaml = require("js-yaml");
		const config = yaml.load(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
		const { getFileMatchers, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
		const destination = mkdtempSync(path.join(tmpdir(), "lh-title-resource-"));
		try {
			for (const platform of ["mac", "win", "linux"]) {
				const matchers = getFileMatchers(config, "extraResources", destination, {
					defaultSrc: root, customBuildOptions: config[platform], macroExpander: (value: string) => value,
					globalOutDir: path.join(root, "dist"),
				});
				assert.ok(matchers.some((matcher: { to: string }) => matcher.to === path.join(destination, "server")), "shared standalone payload remains included");
				const guards = matchers.filter((matcher: { to: string }) => matcher.to === path.join(destination, "server-title-guard.cjs"));
				assert.equal(guards.length, platform === "mac" ? 1 : 0);
				if (platform === "mac") {
					await copyFiles(guards, null, false);
					assert.equal(readFileSync(path.join(destination, "server-title-guard.cjs"), "utf8"), guardSource);
				}
			}
		} finally {
			rmSync(destination, { recursive: true, force: true });
		}
	});
});

/** Linux server mode: flag parsing, browser-only env, and the packaged launcher — no Electron, no Next boot. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const { DEFAULTS, TITLE, parseArgs, serverEnv, writePidFile } = require("../electron/server-mode.cjs");
const afterPack = require("../scripts/after-pack.cjs");

describe("server-mode flags", () => {
	it("binds loopback on port 3000 by default", () => {
		assert.deepEqual(DEFAULTS, { host: "127.0.0.1", port: 3000 });
		assert.deepEqual(parseArgs(["--headless"]), { host: "127.0.0.1", port: 3000 });
	});

	it("accepts --flag value and --flag=value", () => {
		assert.deepEqual(parseArgs(["--headless", "--host", "0.0.0.0", "--port", "8080"]), { host: "0.0.0.0", port: 8080 });
		assert.deepEqual(parseArgs(["--host=::", "--port=1", "--headless"]), { host: "::", port: 1 });
	});

	it("ignores the --no-sandbox that AppRun inserts", () => {
		assert.deepEqual(parseArgs(["--no-sandbox", "--headless", "--port", "9000"]), { host: "127.0.0.1", port: 9000 });
	});

	it("resolves --pid-file against the launch directory, before the server changes into the package", () => {
		assert.deepEqual(parseArgs(["--headless", "--pid-file", "/run/lh.pid"]), { host: "127.0.0.1", port: 3000, pidFile: "/run/lh.pid" });
		assert.equal(parseArgs(["--headless", "--pid-file=lh.pid"]).pidFile, path.join(process.cwd(), "lh.pid"));
	});

	for (const [argv, message] of [
		[["--headless", "--pid-file"], /--pid-file needs a value/],
		[["--headless", "--prot", "80"], /unknown argument: --prot/],
		[["--headless", "--port"], /--port needs a value/],
		[["--headless", "--host", "--port", "80"], /--host needs a value/],
		[["--headless", "--port", "0"], /invalid port: 0/],
		[["--headless", "--port", "65536"], /invalid port: 65536/],
		[["--headless", "--port=80x"], /invalid port: 80x/],
	] as const) {
		it(`rejects ${argv.slice(1).join(" ")}`, () => {
			assert.throws(() => parseArgs([...argv]), message);
		});
	}
});

describe("server-mode environment", () => {
	const options = { host: "0.0.0.0", port: 8080 };

	it("removes the desktop API gate so browsers reach /api/*", () => {
		const env = serverEnv(options, { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "x".repeat(64), KEEP: "kept" }, "/home/u");
		assert.equal(env.LH_DESKTOP_SERVER, undefined);
		assert.equal(env.LH_DESKTOP_API_SECRET, undefined);
		assert.equal(env.KEEP, "kept");
		assert.equal(env.HOSTNAME, "0.0.0.0");
		assert.equal(env.PORT, "8080");
		assert.equal(env.NODE_ENV, "production");
	});

	it("shares the desktop app's Linux userData by default", () => {
		const env = serverEnv(options, {}, "/home/u");
		assert.equal(env.LH_DATA_DIR, "/home/u/.config/LearnHarness/data");
		assert.equal(env.LH_AUTH_FILE, "/home/u/.config/LearnHarness/auth.json");
		const xdg = serverEnv(options, { XDG_CONFIG_HOME: "/cfg" }, "/home/u");
		assert.equal(xdg.LH_DATA_DIR, "/cfg/LearnHarness/data");
		assert.equal(xdg.LH_AUTH_FILE, "/cfg/LearnHarness/auth.json");
	});

	it("keeps explicit LH_DATA_DIR and LH_AUTH_FILE", () => {
		const env = serverEnv(options, { LH_DATA_DIR: "/srv/lh/data", LH_AUTH_FILE: "/srv/lh/auth.json" }, "/home/u");
		assert.equal(env.LH_DATA_DIR, "/srv/lh/data");
		assert.equal(env.LH_AUTH_FILE, "/srv/lh/auth.json");
	});
});

describe("server-mode process handles", () => {
	it("names the server so a title match never hits the AppImage FUSE helper", () => {
		assert.equal(TITLE, "learnharness --headless");
		assert(!"./LearnHarness-0.3.9-x86_64.AppImage --headless --host 0.0.0.0".includes(TITLE));
	});

	it("writes the PID and removes the file on exit only while it still names this process", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-pid-"));
		try {
			const file = path.join(dir, "lh.pid");
			const remove = writePidFile(file, 4242);
			assert.equal(readFileSync(file, "utf8"), "4242\n");
			remove();
			assert(!existsSync(file));
			const stale = writePidFile(file, 4242);
			writeFileSync(file, "5353\n");
			stale();
			assert.equal(readFileSync(file, "utf8"), "5353\n", "an older server's exit keeps a newer server's file");
			assert.throws(() => writePidFile(path.join(dir, "missing", "lh.pid")));
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("Linux afterPack launcher", { skip: process.platform === "win32" }, () => {
	function packedApp() {
		const dir = mkdtempSync(path.join(tmpdir(), "lh-launcher-"));
		const binary = path.join(dir, "learnharness");
		// Stands in for the Electron ELF: reports how it was invoked.
		writeFileSync(binary, '#!/bin/sh\necho "node=${ELECTRON_RUN_AS_NODE:-} self=$(basename "$0") args=$*"\n');
		chmodSync(binary, 0o755);
		return { dir, binary };
	}

	async function pack(dir: string) {
		await afterPack({ electronPlatformName: "linux", appOutDir: dir, packager: { executableName: "learnharness" } });
	}

	function run(file: string, args: string[]) {
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		const result = spawnSync(file, args, { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	}

	it("moves the binary to .bin and installs an executable launcher", async () => {
		const { dir, binary } = packedApp();
		try {
			await pack(dir);
			assert.ok(existsSync(`${binary}.bin`));
			assert.match(readFileSync(binary, "utf8"), /^#!\/bin\/sh\n/);
			assert.equal(statSync(binary).mode & 0o777, 0o755);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("starts the desktop app unchanged without --headless", async () => {
		const { dir, binary } = packedApp();
		try {
			await pack(dir);
			assert.equal(run(binary, []), "node= self=learnharness.bin args=");
			assert.equal(run(binary, ["--no-sandbox", "--browser-service"]), "node= self=learnharness.bin args=--no-sandbox --browser-service");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs server-mode.cjs as Node with --headless, also through a /usr/bin-style symlink", async () => {
		const { dir, binary } = packedApp();
		try {
			await pack(dir);
			const script = path.join(dir, "resources", "server-mode.cjs");
			const expected = `node=1 self=learnharness.bin args=${script} --no-sandbox --headless --host 0.0.0.0 --port 8080`;
			assert.equal(run(binary, ["--no-sandbox", "--headless", "--host", "0.0.0.0", "--port", "8080"]), expected);
			const link = path.join(dir, "usr-bin-learnharness");
			symlinkSync(binary, link);
			assert.equal(run(link, ["--no-sandbox", "--headless", "--host", "0.0.0.0", "--port", "8080"]), expected);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("server-mode packaging config", () => {
	it("copies server-mode.cjs outside ASAR only on Linux", async () => {
		const yaml = require("js-yaml");
		const config = yaml.load(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
		const { getFileMatchers, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
		const destination = mkdtempSync(path.join(tmpdir(), "lh-server-mode-resource-"));
		try {
			for (const platform of ["mac", "win", "linux"]) {
				const matchers = getFileMatchers(config, "extraResources", destination, {
					defaultSrc: root, customBuildOptions: config[platform], macroExpander: (value: string) => value,
					globalOutDir: path.join(root, "dist"),
				});
				const launchers = matchers.filter((matcher: { to: string }) => matcher.to === path.join(destination, "server-mode.cjs"));
				assert.equal(launchers.length, platform === "linux" ? 1 : 0);
				if (platform === "linux") {
					await copyFiles(launchers, null, false);
					assert.equal(readFileSync(path.join(destination, "server-mode.cjs"), "utf8"), readFileSync(path.join(root, "electron/server-mode.cjs"), "utf8"));
				}
			}
		} finally {
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it("attaches the deb AppArmor profile to the moved Electron binary", () => {
		const yaml = require("js-yaml");
		const config = yaml.load(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
		const profile = readFileSync(path.join(root, config.deb.appArmorProfile), "utf8");
		assert.match(profile, /"\/opt\/\$\{sanitizedProductName\}\/\$\{executable\}\.bin"/);
		assert.match(profile, /^\s*userns,$/m);
	});
});

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { test } from "node:test";
import { resolveClaudeBinary, resolveCliBinary, type CliBinarySpec } from "../src/agent/claude-code/binary.ts";
import { inspectCliInstallation } from "../src/agent/claude-code/installation.ts";
import { ClaudeLaunchError, CliLaunchError, createCliLauncher } from "../src/agent/claude-code/launch.ts";

const version = { versionPattern: /^Other v(\d+)\.(\d+)\.(\d+)$/, minimumVersion: "4.2.0" };
const binary = "/tools/other";
const options = { cwd: "/work", env: { NODE_ENV: "test" as const } };

test("generic lookup accepts configured names, directories, and extension policy", () => {
	const spec: CliBinarySpec = { windowsNames: ["other.cmd"], posixNames: ["other"], knownDirs: () => ["C:\\tools"], excludedExtensions: [] };
	const lookup = { env: {}, platform: "win32" as const, homeDir: "C:\\home", isExecutable: (candidate: string) => candidate === "C:\\tools\\other.cmd" };
	assert.equal(resolveCliBinary(spec, lookup), "C:\\tools\\other.cmd");
	assert.equal(resolveCliBinary({ ...spec, excludedExtensions: [".cmd"] }, lookup), null);
});

test("extension policy discovers allowed alternatives while Claude excludes cmd", () => {
	const spec: CliBinarySpec = { windowsNames: ["other.exe"], posixNames: ["other"], knownDirs: () => ["C:\\tools"], excludedExtensions: [] };
	const lookup = { env: { PATH: "C:\\tools" }, platform: "win32" as const, homeDir: "C:\\home", isExecutable: (candidate: string) => ["C:\\tools\\other.cmd", "C:\\tools\\claude.cmd"].includes(candidate) };
	assert.equal(resolveCliBinary(spec, lookup), "C:\\tools\\other.cmd");
	assert.equal(resolveCliBinary({ ...spec, excludedExtensions: [".cmd"] }, lookup), null);
	assert.equal(resolveClaudeBinary(lookup), null);
});

test("generic launcher rejects an old version with a generic error", async () => {
	const launch = createCliLauncher({ name: "Other", version }, { findBinary: () => binary, readVersion: async () => "Other v4.1.9" });
	await assert.rejects(launch([], options) as Promise<unknown>, (error: unknown) => error instanceof CliLaunchError && !(error instanceof ClaudeLaunchError));
});

test("generic launcher returns null when the binary is missing", async () => {
	const launch = createCliLauncher({ name: "Other", version }, { findBinary: () => null, readVersion: async () => assert.fail("unexpected probe") });
	assert.equal(await launch([], options), null);
});

for (const [output, state] of [["Other v4.1.9", "update-required"], ["unreadable", "version-unchecked"]] as const) {
	test(`generic launcher rejects ${state}`, async () => {
		assert.equal((await inspectCliInstallation(version, () => binary, async () => output)).state, state);
		const launch = createCliLauncher({ name: "Other", version }, { findBinary: () => binary, readVersion: async () => output,
			spawnProcess: (() => assert.fail("unexpected spawn")) as typeof spawn });
		await assert.rejects(launch([], options) as Promise<unknown>);
	});
}

test("generic launcher directly spawns a supported version", async () => {
	const child = {} as ChildProcessWithoutNullStreams;
	const launch = createCliLauncher({ name: "Other", version }, { findBinary: () => binary, readVersion: async () => "Other v4.2.0",
		spawnProcess: ((file: string, args: string[], spawnOptions: unknown) => {
			assert.equal(file, binary);
			assert.deepEqual(args, ["run"]);
			assert.deepEqual(spawnOptions, { ...options, stdio: "pipe", windowsHide: true });
			return child;
		}) as typeof spawn });
	assert.equal(await launch(["run"], options), child);
});

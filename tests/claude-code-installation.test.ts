import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { test } from "node:test";
import { inspectClaudeInstallation } from "../src/agent/claude-code/installation.ts";
import { ClaudeLaunchError, createClaudeLauncher } from "../src/agent/claude-code/launch.ts";

const binary = "/fake/claude";
const options = { cwd: "/fake/work", env: { NODE_ENV: "test" as const, ANTHROPIC_API_KEY: "native-test-key" } };

test("missing installation does not execute a command", async () => {
	assert.deepEqual(await inspectClaudeInstallation(() => null, async () => { throw new Error("must not run"); }), {
		state: "not-found", version: null, minimumVersion: "2.1.259",
	});
});

for (const [output, state, version] of [
	["2.1.258 (Claude Code)\n", "update-required", "2.1.258"],
	["2.1.259 (Claude Code)", "meets-minimum", "2.1.259"],
	["2.1.310 (Claude Code)", "meets-minimum", "2.1.310"],
	["2.2.0", "meets-minimum", "2.2.0"],
	["2.0.999", "update-required", "2.0.999"],
	["3.0.0", "meets-minimum", "3.0.0"],
	["unexpected output containing private details", "version-unchecked", null],
	["2.1.310-preview", "version-unchecked", null],
	["99999999999999999999999999.1.1", "version-unchecked", null],
] as const) test(`installation version output ${JSON.stringify(output)} gives ${state}`, async () => {
	const status = await inspectClaudeInstallation(() => binary, async (path) => { assert.equal(path, binary); return output; });
	assert.deepEqual(status, { state, version, minimumVersion: "2.1.259" });
});

test("probe failures expose neither raw errors nor binary paths", async () => {
	const status = await inspectClaudeInstallation(() => binary, async () => { throw new Error("timeout /private/path secret-token"); });
	assert.deepEqual(status, { state: "version-unchecked", version: null, minimumVersion: "2.1.259" });
});

for (const output of ["2.1.258", "garbage", null]) test(`launcher refuses ${output ?? "failed"} version check before model work`, async () => {
	const launch = createClaudeLauncher({ findBinary: () => binary,
		readVersion: async () => { if (output === null) throw new Error("failed probe"); return output; },
		spawnProcess: (() => { assert.fail("must not start model work"); }) as typeof spawn,
	});
	await assert.rejects(launch(["-p"], options) as Promise<unknown>, ClaudeLaunchError);
});

test("launcher uses the verified executable directly and preserves model args and native env", async () => {
	const child = {} as ChildProcessWithoutNullStreams;
	let calls = 0;
	const launch = createClaudeLauncher({ findBinary: () => binary, readVersion: async () => "2.1.310 (Claude Code)",
		spawnProcess: ((path: string, args: string[], opts: unknown) => {
			calls++;
			assert.equal(path, binary);
			assert.deepEqual(args, ["-p", "--tools", ""]);
			assert.deepEqual(opts, { ...options, stdio: "pipe" });
			return child;
		}) as typeof spawn,
	});
	assert.equal(await launch(["-p", "--tools", ""], options), child);
	assert.equal(calls, 1);
});

test("aborting during a version check prevents model process creation", async () => {
	const controller = new AbortController();
	const launch = createClaudeLauncher({ findBinary: () => binary,
		readVersion: async () => { controller.abort(); return "2.1.310"; },
		spawnProcess: (() => { assert.fail("must not start after abort"); }) as typeof spawn,
	});
	await assert.rejects(launch([], { ...options, signal: controller.signal }) as Promise<unknown>, /aborted/);
});

test("missing executable is not mistaken for an unchecked version", async () => {
	const launch = createClaudeLauncher({ findBinary: () => null, readVersion: async () => assert.fail("must not probe") });
	assert.equal(await launch([], options), null);
});

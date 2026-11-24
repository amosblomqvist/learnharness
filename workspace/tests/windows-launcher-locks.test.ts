/** Exercise the launcher's pre-`npm ci` lock check against a real held file on Windows. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { assertNodeModulesUnlocked, findLockHolders, findLockedFiles } from "../scripts/windows-node-modules-locks.mjs";

function fixture(t: TestContext) {
	const directory = mkdtempSync(path.join(tmpdir(), "learnharness-locks-test-"));
	// Release held files before removing the folder: Windows refuses to delete a held file.
	const cleanups: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
	t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
	const nodeModules = path.join(directory, "node_modules");
	const binary = path.join(nodeModules, "@scope", "native", "binding.dll");
	mkdirSync(path.dirname(binary), { recursive: true });
	writeFileSync(binary, "fixture");
	writeFileSync(path.join(nodeModules, "@scope", "native", "index.js"), "");
	return { directory, nodeModules, binary, hold: (filename: string) => hold(cleanups, filename) };
}

/** Hold `filename` open without sharing, the way a loaded native module blocks npm's delete. */
async function hold(cleanups: Array<() => unknown>, filename: string) {
	const powershell = path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command",
		"$f = [IO.File]::Open($env:LH_HELD_FILE, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 120"],
	{ env: { ...process.env, LH_HELD_FILE: filename }, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
	const exited = new Promise(resolve => child.once("exit", resolve));
	cleanups.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout.on("data", chunk => { if (String(chunk).includes("held")) resolve(); });
		child.once("exit", code => reject(new Error(`holder exited early (${code})`)));
	});
	return child.pid!;
}

describe("Windows launcher node_modules lock check", { skip: process.platform !== "win32" }, () => {
	it("passes an unlocked tree and a missing node_modules", t => {
		const test = fixture(t);
		assert.deepEqual(findLockedFiles(test.nodeModules), []);
		assert.doesNotThrow(() => assertNodeModulesUnlocked(test.nodeModules));
		assert.doesNotThrow(() => assertNodeModulesUnlocked(path.join(test.directory, "missing")));
	});

	it("reports held binaries and names every process holding them", async t => {
		const test = fixture(t);
		const second = path.join(test.nodeModules, "other", "tool.exe");
		mkdirSync(path.dirname(second), { recursive: true });
		writeFileSync(second, "fixture");
		const pids = [await test.hold(test.binary), await test.hold(second)];
		assert.deepEqual(findLockedFiles(test.nodeModules), [test.binary, second].sort());
		const holders: Array<{ pid: number; name: string }> = findLockHolders([test.binary, second]);
		for (const pid of pids) assert.ok(holders.some(holder => holder.pid === pid && /powershell/i.test(holder.name)), JSON.stringify(holders));
		assert.throws(() => assertNodeModulesUnlocked(test.nodeModules), (error: Error) => {
			assert.match(error.message, /Dependencies need reinstalling/);
			for (const pid of pids) assert.match(error.message, new RegExp(`PID ${pid}\\b`));
			assert.match(error.message, /Nothing was changed\.$/);
			return true;
		});
	});

	it("lists the locked files when Windows cannot name the holders", async t => {
		const test = fixture(t);
		await test.hold(test.binary);
		assert.throws(() => assertNodeModulesUnlocked(test.nodeModules, { findHolders: () => { throw new Error("unavailable"); } }), (error: Error) => {
			assert.match(error.message, /could not name the programs: unavailable/);
			assert.match(error.message, /@scope[\\/]native[\\/]binding\.dll/);
			return true;
		});
	});

	it("does not follow a junction out of node_modules", async t => {
		const test = fixture(t);
		const outside = path.join(test.directory, "outside");
		mkdirSync(outside);
		const held = path.join(outside, "held.dll");
		writeFileSync(held, "fixture");
		symlinkSync(outside, path.join(test.nodeModules, "linked"), "junction");
		await test.hold(held);
		assert.deepEqual(findLockedFiles(test.nodeModules), []);
	});
});

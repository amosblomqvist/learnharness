import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, it, mock } from "node:test";
import { boundedSmokeOperation, stopOwnedSmokeServer } from "../scripts/lib/owned-smoke-lifetime.mjs";

describe("learner-image smoke owned lifetimes", () => {
	it("a never-resolving diagnostic cannot prevent finally cleanup", { timeout: 3000 }, async () => {
		let cleaned = false;
		let diagnosticStarted = false;
		try {
			const result = await boundedSmokeOperation(() => {
				diagnosticStarted = true;
				return new Promise<null>(() => {}); // An unresponsive renderer's evaluate.
			}, 20, null);
			assert.equal(result, null);
		} finally { cleaned = true; }
		assert.equal(diagnosticStarted, true);
		assert.equal(cleaned, true);
	});

	it("consumes a diagnostic failure and returns a successful diagnostic unchanged", async () => {
		assert.equal(await boundedSmokeOperation(async () => { throw new Error("Target closed"); }, 100, null), null);
		assert.deepEqual(await boundedSmokeOperation(async () => ({ text: "synthetic" }), 100, null), { text: "synthetic" });
	});

	it("does not confuse a transient EPERM group probe with group exit", { skip: process.platform === "win32" }, async () => {
		const signals: (number | string | undefined)[] = [];
		let probes = 0;
		// Fully stubbed signal function: no real process or group is addressed.
		const kill = mock.method(process, "kill", (target: number, signal?: number | NodeJS.Signals) => {
			assert.equal(target, -424242);
			signals.push(signal);
			if (signal === 0) throw Object.assign(new Error("probe"), { code: probes++ === 0 ? "EPERM" : "ESRCH" });
			return true;
		});
		try {
			assert.deepEqual(await stopOwnedSmokeServer({ pid: 424242 } as ChildProcess, { graceMs: 100 }), { escalated: false });
			assert.deepEqual(signals, ["SIGTERM", 0, 0]);
		} finally { kill.mock.restore(); }
	});

	it("escalates for an owned descendant even after its detached group leader exits", { skip: process.platform === "win32", timeout: 10000 }, async () => {
		// Both processes are synthetic children created here. The descendant
		// deliberately ignores TERM; no process names or other PIDs are discovered.
		const descendant = 'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);';
		const leader = `
			const { spawn } = require("node:child_process");
			process.on("SIGTERM", () => process.exit(0));
			const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "pipe", "inherit"] });
			child.stdout.once("data", () => console.log("READY"));
			setInterval(() => {}, 1000);
		`;
		const server = spawn(process.execPath, ["-e", leader], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const exited = once(server, "exit");
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("owned fixture startup timed out")), 3000);
				server.once("error", error => { clearTimeout(timeout); reject(error); });
				server.stdout.on("data", chunk => { if (String(chunk).includes("READY")) { clearTimeout(timeout); resolve(); } });
			});
			assert.deepEqual(await stopOwnedSmokeServer(server, { graceMs: 100, killMs: 3000 }), { escalated: true });
			assert.equal((await exited)[0], 0, "the TERM-handling leader exited normally before descendant escalation");
			assert.throws(() => process.kill(-server.pid!, 0), { code: "ESRCH" });
			assert.deepEqual(await stopOwnedSmokeServer(server, { graceMs: 100, killMs: 3000 }), { escalated: false });
		} finally {
			await stopOwnedSmokeServer(server, { graceMs: 100, killMs: 3000 });
			server.stdout.destroy(); server.stderr.destroy();
		}
	});
});

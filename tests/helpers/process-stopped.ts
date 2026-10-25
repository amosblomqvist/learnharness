import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function isStopped(pid: number): boolean {
	try { process.kill(pid, 0); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		throw error;
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ", 1)[0];
			// A terminated orphan can remain addressable until PID 1 reaps it.
			if (state === "Z" || state === "X" || state === "x") return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	}
	return false;
}

/** Signal delivery is asynchronous; a live process must still fail this check. */
export async function assertProcessStopped(pid: number, timeoutMs = 2000): Promise<void> {
	assert.ok(Number.isSafeInteger(pid) && pid > 0, "a positive process ID is required");
	const deadline = performance.now() + timeoutMs;
	while (!isStopped(pid)) {
		assert.ok(performance.now() < deadline, `Process ${pid} is still running after cleanup`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

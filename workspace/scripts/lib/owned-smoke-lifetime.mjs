/** Bounded cleanup for a POSIX process group created by this smoke's detached spawn.
 * Never discovers processes by name, and never equates leader exit with group exit.
 */
import { setTimeout as delay } from "node:timers/promises";

/** @template T @param {() => Promise<T>} operation @param {number} timeoutMs @param {T} fallback */
export async function boundedSmokeOperation(operation, timeoutMs, fallback) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(operation).catch(() => fallback),
			new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
		]);
	} finally { clearTimeout(timer); }
}

/** @param {import("node:child_process").ChildProcess} server
 * @param {{ graceMs?: number, killMs?: number }} options
 */
export async function stopOwnedSmokeServer(server, { graceMs = 3000, killMs = 3000 } = {}) {
	if (process.platform === "win32" || !server.pid) throw new Error("Owned smoke cleanup requires a successfully spawned detached POSIX group");
	// The caller must have used detached:true. Retain that exact spawn's group ID.
	const group = -server.pid;
	const signalGroup = signal => {
		try { process.kill(group, signal); return true; }
		catch (error) {
			if (error.code === "ESRCH") return false;
			// A POSIX permission denial on signal 0 still means the group may
			// exist (including a transient shutdown/reaping state). Never call it gone.
			if (signal === 0 && error.code === "EPERM") return true;
			throw new Error(`Cannot signal owned smoke group ${server.pid} with ${signal}`, { cause: error });
		}
	};
	const waitForGroupExit = async timeoutMs => {
		const deadline = performance.now() + timeoutMs;
		while (signalGroup(0)) {
			if (performance.now() >= deadline) return false;
			await delay(Math.min(25, Math.max(1, deadline - performance.now())));
		}
		return true;
	};
	if (!signalGroup("SIGTERM")) return { escalated: false };
	if (await waitForGroupExit(graceMs)) return { escalated: false };
	// Leader exit deliberately does not cancel this escalation.
	const escalated = signalGroup("SIGKILL");
	if (!await waitForGroupExit(killMs)) throw new Error(`Owned smoke group ${server.pid} survived bounded cleanup`);
	return { escalated };
}

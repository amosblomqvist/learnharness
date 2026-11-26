import { spawn } from "node:child_process";
import type { AgyStatus } from "../../core/contracts/agy.ts";
import { getAgyBinary } from "./binary.ts";
import { inspectAgyInstallation, readAgyVersion, type ReadAgyVersion } from "./installation.ts";
import type { RunAgy } from "./stream.ts";

export class AgyLaunchError extends Error {}

const VERSION_CACHE_TTL_MS = 60_000;

export function createAgyLauncher({
	findBinary = getAgyBinary,
	readVersion = readAgyVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadAgyVersion;
	spawnProcess?: typeof spawn;
} = {}): RunAgy {
	let cachedStatus: { binary: string; status: AgyStatus; timestamp: number } | null = null;

	return async (args, options) => {
		if (options.signal?.aborted) throw new AgyLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		const now = Date.now();
		let status: AgyStatus;
		if (cachedStatus && cachedStatus.binary === binary && (now - cachedStatus.timestamp < VERSION_CACHE_TTL_MS)) {
			status = cachedStatus.status;
		} else {
			status = await inspectAgyInstallation(() => binary, readVersion);
			if (status.state === "meets-minimum") {
				cachedStatus = { binary, status, timestamp: now };
			}
		}
		if (status.state === "update-required") {
			throw new AgyLaunchError(`Antigravity CLI ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update Antigravity CLI outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new AgyLaunchError("Antigravity CLI's version could not be checked. Check your installation outside LearnHarness and try again.");
		}
		if (options.signal?.aborted) throw new AgyLaunchError("Request was aborted");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
	};
}

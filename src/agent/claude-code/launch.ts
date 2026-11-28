import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getClaudeBinary } from "./binary.ts";
import { inspectClaudeInstallation, readClaudeVersion, type ReadClaudeVersion } from "./installation.ts";
import type { RunClaude } from "./stream.ts";

export class ClaudeLaunchError extends Error {}

function assertValidClaudeConfigDir(configDir: string | undefined): void {
	if (configDir === undefined) return;
	const trimmed = configDir.trim();
	if (!trimmed || configDir.includes("\0") || !path.isAbsolute(configDir)) {
		throw new ClaudeLaunchError("Claude Code config directory must be a valid absolute path. Check your Claude Code profile in Settings.");
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(/* turbopackIgnore: true */ configDir);
	} catch {
		throw new ClaudeLaunchError("Configured Claude Code profile directory does not exist or cannot be accessed. Choose another profile in Settings and try again.");
	}
	if (!stat.isDirectory()) {
		throw new ClaudeLaunchError("Configured Claude Code profile path is not a directory. Choose another profile in Settings and try again.");
	}
	try {
		fs.accessSync(/* turbopackIgnore: true */ configDir, fs.constants.R_OK);
	} catch {
		throw new ClaudeLaunchError("Configured Claude Code profile directory is not readable. Check permissions or choose another profile in Settings.");
	}
}

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createClaudeLauncher({
	findBinary = getClaudeBinary,
	readVersion = readClaudeVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadClaudeVersion;
	spawnProcess?: typeof spawn;
} = {}): RunClaude {
	return async (args, options) => {
		if (options.signal?.aborted) throw new ClaudeLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		assertValidClaudeConfigDir(options.env.CLAUDE_CONFIG_DIR);
		const status = await inspectClaudeInstallation(() => binary, readVersion);
		if (status.state === "update-required") {
			throw new ClaudeLaunchError(`Claude Code ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update Claude Code outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new ClaudeLaunchError("Claude Code's version could not be checked. Check your installation outside LearnHarness and try again.");
		}
		if (options.signal?.aborted) throw new ClaudeLaunchError("Request was aborted");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
	};
}

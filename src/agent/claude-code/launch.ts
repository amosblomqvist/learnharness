import { spawn } from "node:child_process";
import { getClaudeBinary } from "./binary.ts";
import { inspectClaudeInstallation, readClaudeVersion, type ReadClaudeVersion } from "./installation.ts";
import type { RunClaude } from "./stream.ts";
import { tr } from "../../core/i18n.ts";

export class ClaudeLaunchError extends Error {}

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
		const status = await inspectClaudeInstallation(() => binary, readVersion);
		if (status.state === "update-required") {
			throw new ClaudeLaunchError(tr(`Claude Code ${status.version} 需要更新。LearnHarness 至少需要 ${status.minimumVersion} 版本；请在 LearnHarness 之外更新 Claude Code。`, `Claude Code ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update Claude Code outside LearnHarness.`));
		}
		if (status.state !== "meets-minimum") {
			throw new ClaudeLaunchError(tr("无法检查 Claude Code 的版本。请在 LearnHarness 之外检查安装情况，然后重试。", "Claude Code's version could not be checked. Check your installation outside LearnHarness and try again."));
		}
		if (options.signal?.aborted) throw new ClaudeLaunchError("Request was aborted");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
	};
}

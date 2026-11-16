import { spawn } from "node:child_process";
import { getClaudeBinary } from "./binary.ts";
import { claudeVersionSpec, inspectCliInstallation, readClaudeVersion, readCliVersion, type CliVersionSpec, type ReadClaudeVersion, type ReadCliVersion } from "./installation.ts";
import type { RunCli } from "../external-cli/adapter.ts";
import type { RunClaude } from "./stream.ts";

export class CliLaunchError extends Error {}
export class ClaudeLaunchError extends CliLaunchError {}

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
	const launch = createCliLauncher({ name: "Claude Code", version: claudeVersionSpec }, { findBinary, readVersion, spawnProcess });
	return async (args, options) => {
		try { return await launch(args, options); }
		catch (error) {
			if (error instanceof CliLaunchError) throw new ClaudeLaunchError(error.message);
			throw error;
		}
	};
}

/** What to start for a found binary: the program and the arguments that come before the CLI's own. */
export type CliCommand = { file: string; leadingArgs: string[] };

export function createCliLauncher(spec: { name: string; version: CliVersionSpec }, {
	findBinary,
	readVersion = readCliVersion,
	spawnProcess = spawn,
	commandFor = (binary) => ({ file: binary, leadingArgs: [] }),
}: { findBinary: () => string | null; readVersion?: ReadCliVersion; spawnProcess?: typeof spawn; commandFor?: (binary: string) => CliCommand }): RunCli {
	return async (args, options) => {
		if (options.signal?.aborted) throw new CliLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		const status = await inspectCliInstallation(spec.version, () => binary, readVersion);
		if (status.state === "update-required") {
			throw new CliLaunchError(`${spec.name} ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update ${spec.name} outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new CliLaunchError(`${spec.name}'s version could not be checked. Check your installation outside LearnHarness and try again.`);
		}
		if (options.signal?.aborted) throw new CliLaunchError("Request was aborted");
		const command = commandFor(binary);
		// windowsHide: a packaged Windows app has no console, so each child would otherwise open a console window.
		return spawnProcess(command.file, [...command.leadingArgs, ...args], { cwd: options.cwd, env: options.env, stdio: "pipe", windowsHide: true });
	};
}

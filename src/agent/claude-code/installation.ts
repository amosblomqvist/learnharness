import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import { CLAUDE_CODE_MINIMUM_VERSION, type ClaudeCodeStatus } from "../../core/contracts/claude-code.ts";
import { getClaudeBinary } from "./binary.ts";

export type ReadCliVersion = (binary: string) => Promise<string>;
export type ReadClaudeVersion = ReadCliVersion;
export type CliInstallationStatus = { state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked"; version: string | null; minimumVersion: string };
export type CliVersionSpec = { versionPattern: RegExp; minimumVersion: string };
export const claudeVersionSpec: CliVersionSpec = {
	versionPattern: /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/,
	minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
};

/** No shell, auth-status command, model call, or credential-file inspection. */
export const readCliVersion: ReadCliVersion = (binary) => readCliVersionWith(binary, []);

/** `file leadingArgs... --version`: lets a launcher run a script through the program that starts it (e.g. `node gemini.js`). */
export function readCliVersionWith(file: string, leadingArgs: string[], extraEnv?: Readonly<Record<string, string>>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, [...leadingArgs, "--version"], {
			cwd: tmpdir(), env: extraEnv ? { ...externalCliEnv(), ...extraEnv } : externalCliEnv(), windowsHide: true,
			timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
		}, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}
export const readClaudeVersion: ReadClaudeVersion = readCliVersion;

export async function inspectClaudeInstallation(
	findBinary: () => string | null = getClaudeBinary,
	readVersion: ReadClaudeVersion = readClaudeVersion,
): Promise<ClaudeCodeStatus> {
	return inspectCliInstallation(claudeVersionSpec, findBinary, readVersion);
}

export async function inspectCliInstallation(
	spec: CliVersionSpec,
	findBinary: () => string | null,
	readVersion: ReadCliVersion = readCliVersion,
): Promise<CliInstallationStatus> {
	const base = { version: null, minimumVersion: spec.minimumVersion };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	try {
		const output = await readVersion(binary);
		// Expose only a version, never arbitrary CLI stdout/stderr or an absolute path.
		const match = new RegExp(spec.versionPattern.source, spec.versionPattern.flags).exec(output.trim());
		if (!match || match.length !== 4 || !match.slice(1).every((part) => /^\d+$/.test(part))) return { ...base, state: "version-unchecked" };
		const parts = match.slice(1).map(Number);
		if (!parts.every(Number.isSafeInteger)) return { ...base, state: "version-unchecked" };
		const minimum = spec.minimumVersion.split(".").map(Number);
		const differing = parts.findIndex((part, index) => part !== minimum[index]);
		const meetsMinimum = differing === -1 || parts[differing]! > minimum[differing]!;
		return { ...base, version: parts.join("."), state: meetsMinimum ? "meets-minimum" : "update-required" };
	} catch {
		return { ...base, state: "version-unchecked" };
	}
}

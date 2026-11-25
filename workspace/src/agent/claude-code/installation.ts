import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import { CLAUDE_CODE_MINIMUM_VERSION, type ClaudeCodeStatus } from "../../core/contracts/claude-code.ts";
import { getClaudeBinary } from "./binary.ts";

export type ReadClaudeVersion = (binary: string) => Promise<string>;

/** No shell, auth-status command, model call, or credential-file inspection. */
export const readClaudeVersion: ReadClaudeVersion = (binary) => new Promise((resolve, reject) => {
	execFile(binary, ["--version"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function inspectClaudeInstallation(
	findBinary: () => string | null = getClaudeBinary,
	readVersion: ReadClaudeVersion = readClaudeVersion,
): Promise<ClaudeCodeStatus> {
	const base = { version: null, minimumVersion: CLAUDE_CODE_MINIMUM_VERSION };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	try {
		const output = await readVersion(binary);
		// Expose only a version, never arbitrary CLI stdout/stderr or an absolute path.
		const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(output.trim());
		if (!match) return { ...base, state: "version-unchecked" };
		const parts = match.slice(1).map(Number);
		if (!parts.every(Number.isSafeInteger)) return { ...base, state: "version-unchecked" };
		const minimum = CLAUDE_CODE_MINIMUM_VERSION.split(".").map(Number);
		const differing = parts.findIndex((part, index) => part !== minimum[index]);
		const meetsMinimum = differing === -1 || parts[differing]! > minimum[differing]!;
		return { ...base, version: parts.join("."), state: meetsMinimum ? "meets-minimum" : "update-required" };
	} catch {
		return { ...base, state: "version-unchecked" };
	}
}

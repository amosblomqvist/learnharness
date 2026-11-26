import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import { OPENCODE_MINIMUM_VERSION, type OpenCodeStatus } from "../../core/contracts/opencode.ts";
import { getOpenCodeBinary } from "./binary.ts";

export type ReadOpenCodeVersion = (binary: string) => Promise<string>;

export const readOpenCodeVersion: ReadOpenCodeVersion = (binary) => new Promise((resolve, reject) => {
	execFile(binary, ["--version"], { cwd: tmpdir(), env: externalCliEnv(), windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function inspectOpenCodeInstallation(findBinary: () => string | null = getOpenCodeBinary, readVersion: ReadOpenCodeVersion = readOpenCodeVersion): Promise<OpenCodeStatus> {
	const base = { version: null, minimumVersion: OPENCODE_MINIMUM_VERSION };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	try {
		const output = await readVersion(binary);
		const match = /(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
		if (!match) return { ...base, state: "version-unchecked" };
		const parts = match.slice(1).map(Number);
		const minimum = OPENCODE_MINIMUM_VERSION.split(".").map(Number);
		const differing = parts.findIndex((part, index) => part !== minimum[index]);
		const meetsMinimum = differing === -1 || parts[differing]! > minimum[differing]!;
		return { ...base, version: parts.join("."), state: meetsMinimum ? "meets-minimum" : "version-unchecked" };
	} catch { return { ...base, state: "version-unchecked" }; }
}

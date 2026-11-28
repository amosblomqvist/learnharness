import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import { AGY_MINIMUM_VERSION, type AgyStatus } from "../../core/contracts/agy.ts";
import { getAgyBinary } from "./binary.ts";

export type ReadAgyVersion = (binary: string) => Promise<string>;

export const readAgyVersion: ReadAgyVersion = (binary) => new Promise((resolve, reject) => {
	execFile(binary, ["--version"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function inspectAgyInstallation(
	findBinary: () => string | null = getAgyBinary,
	readVersion: ReadAgyVersion = readAgyVersion,
): Promise<AgyStatus> {
	const base = { version: null, minimumVersion: AGY_MINIMUM_VERSION };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	try {
		const output = await readVersion(binary);
		const match = /^(\d+)\.(\d+)\.(\d+)(?: \([^)]+\))?$/.exec(output.trim());
		if (!match) return { ...base, state: "version-unchecked" };
		const parts = match.slice(1).map(Number);
		if (!parts.every(Number.isSafeInteger)) return { ...base, state: "version-unchecked" };
		const minimum = AGY_MINIMUM_VERSION.split(".").map(Number);
		const differing = parts.findIndex((part, index) => part !== minimum[index]);
		const meetsMinimum = differing === -1 || parts[differing]! > minimum[differing]!;
		return { ...base, version: parts.join("."), state: meetsMinimum ? "meets-minimum" : "update-required" };
	} catch {
		return { ...base, state: "version-unchecked" };
	}
}

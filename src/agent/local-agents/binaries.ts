import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_KEYS, AUTH_PROVIDER_KEYS } from "../../core/auth-keys.ts";

/**
 * Locating a locally installed agent runtime. A desktop app launched from
 * the Dock/Start menu does not inherit the learner's shell PATH, so the
 * search is: an explicit env override → the server's PATH → the login
 * shell's PATH (probed once) → the vendors' documented install locations.
 */

export interface BinarySpec {
	/** Env var naming an explicit executable path (wins when set). */
	envVar: string;
	/** Executable names, in preference order (platform suffixes included by the caller). */
	names: string[];
	/** Vendor install locations searched last. */
	knownDirs: string[];
}

function executable(file: string): boolean {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

let shellPath: Promise<string[]> | undefined;
/** The login shell's PATH entries (POSIX only; cached for the process). */
export function loginShellPath(): Promise<string[]> {
	if (process.platform === "win32") return Promise.resolve([]);
	shellPath ??= new Promise((resolve) => {
		const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
		const marker = "__LH_PATH__";
		// The shell is the learner's own, not a project file: keep it out of build tracing.
		execFile(/*turbopackIgnore: true*/ shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], { timeout: 5_000, env: process.env }, (error, stdout) => {
			const match = !error ? stdout.match(new RegExp(`${marker}(.*)${marker}`)) : null;
			resolve(match?.[1] ? match[1].split(path.delimiter).filter(Boolean) : []);
		});
	});
	return shellPath;
}

/** Test seam: forget the cached login-shell PATH. */
export function resetBinaryCache(): void { shellPath = undefined; }

export async function resolveBinary(spec: BinarySpec): Promise<string | undefined> {
	const override = process.env[spec.envVar]?.trim();
	if (override) return executable(override) ? override : undefined;
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
		...(await loginShellPath()),
		...spec.knownDirs,
	];
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		for (const name of spec.names) {
			const candidate = path.join(dir, name);
			if (executable(candidate)) return candidate;
		}
	}
	return undefined;
}

export function homeDir(): string { return os.homedir(); }

// ── child environment ────────────────────────────────────────────────────

let heldVars: () => readonly string[] = () => [];
/** Wiring seam (server composition): the env var names the app's key store holds (auth.json). */
export function configureAppHeldEnvVars(source: () => readonly string[]): void { heldVars = source; }
/**
 * Every env var LearnHarness itself manages — provider and tool keys plus
 * anything saved in its key store. The keys seam reflects them into the
 * server's environment; a vendor runtime must never inherit them.
 */
export function appHeldEnvVars(): string[] {
	let saved: readonly string[] = [];
	try { saved = heldVars(); } catch { /* an unreadable store holds nothing to pass on */ }
	return [...new Set([...AUTH_PROVIDER_KEYS.map((p) => p.envVar), ...AUTH_KEYS.map((k) => k.id), ...saved])];
}

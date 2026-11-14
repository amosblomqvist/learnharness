import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCliBinary, type BinaryLookup, type CliBinarySpec } from "../claude-code/binary.ts";

/** Where npm puts the official bundle, relative to the directory of `gemini.cmd`. */
const BUNDLE_SEGMENTS = ["node_modules", "@google", "gemini-cli", "bundle", "gemini.js"];
const BUNDLE_SCRIPT_NAME = "gemini.js";
const WINDOWS_SHIM_NAME = "gemini.cmd";

export type GeminiLookup = BinaryLookup & { isFile: (path: string) => boolean };

export const GeminiInstallKind = {
	/** A real executable (`gemini`, or `gemini.exe`): started directly. */
	BINARY: "binary",
	/** Windows npm install: `node <bundle>/gemini.js`, found next to `gemini.cmd`. No shell is involved. */
	BUNDLE: "bundle",
	/** The bundle is there but `node` is not on PATH. */
	NODE_MISSING: "node-missing",
	NOT_FOUND: "not-found",
} as const;

export type GeminiInstall =
	| { kind: typeof GeminiInstallKind.BINARY; binary: string }
	| { kind: typeof GeminiInstallKind.BUNDLE; script: string; node: string }
	| { kind: typeof GeminiInstallKind.NODE_MISSING; script: string }
	| { kind: typeof GeminiInstallKind.NOT_FOUND };

const geminiBinarySpec: CliBinarySpec = {
	windowsNames: ["gemini.exe"],
	posixNames: ["gemini"],
	knownDirs: ({ env, platform, homeDir }, paths) => platform === "win32"
		? [npmPrefixDir(env, homeDir)]
		: [
			paths.join(homeDir, ".local", "bin"),
			env.npm_config_prefix ? paths.join(env.npm_config_prefix, "bin") : paths.join(homeDir, ".npm-global", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
		],
	// Direct spawn uses no shell, so a `.cmd` is never started itself.
	excludedExtensions: [".cmd", ".bat"],
};

const nodeBinarySpec: CliBinarySpec = {
	windowsNames: ["node.exe"],
	posixNames: ["node"],
	knownDirs: () => [],
	excludedExtensions: [".cmd", ".bat"],
};

function npmPrefixDir(env: BinaryLookup["env"], homeDir: string): string {
	return env.npm_config_prefix ?? path.win32.join(env.APPDATA ?? path.win32.join(homeDir, "AppData", "Roaming"), "npm");
}

/** Pure: the PATH, the platform and the existence checks come in as arguments. */
export function resolveGeminiInstall(lookup: GeminiLookup): GeminiInstall {
	const binary = resolveCliBinary(geminiBinarySpec, lookup);
	if (binary) return { kind: GeminiInstallKind.BINARY, binary };
	if (lookup.platform !== "win32") return { kind: GeminiInstallKind.NOT_FOUND };

	const { env, cwd = process.cwd() } = lookup;
	const paths = path.win32;
	const dirs = [...(env.PATH ?? "").split(paths.delimiter).filter(Boolean), npmPrefixDir(env, lookup.homeDir)];
	for (const dir of dirs) {
		const directory = paths.resolve(cwd, dir);
		if (!lookup.isFile(paths.join(directory, WINDOWS_SHIM_NAME))) continue;
		const script = paths.join(directory, ...BUNDLE_SEGMENTS);
		if (!lookup.isFile(script)) continue;
		const node = resolveCliBinary(nodeBinarySpec, lookup);
		return node ? { kind: GeminiInstallKind.BUNDLE, script, node } : { kind: GeminiInstallKind.NODE_MISSING, script };
	}
	return { kind: GeminiInstallKind.NOT_FOUND };
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getGeminiInstall(): GeminiInstall {
	return resolveGeminiInstall({ env: process.env, platform: process.platform, homeDir: os.homedir(), isExecutable: isExecutableFile, isFile });
}

/**
 * What to start, or null. A bundle whose `node` is missing still returns its script ("the CLI is
 * installed"); the launcher then stops the turn with the Node.js message, and Settings shows `node-missing`.
 * The one place that turns an install into a program to find, for the turn gate, the launcher and Settings.
 */
export function geminiBinaryOf(install: GeminiInstall): string | null {
	switch (install.kind) {
		case GeminiInstallKind.BINARY: return install.binary;
		case GeminiInstallKind.BUNDLE:
		case GeminiInstallKind.NODE_MISSING: return install.script;
		case GeminiInstallKind.NOT_FOUND: return null;
	}
}

export function findGeminiBinary(): string | null {
	return geminiBinaryOf(getGeminiInstall());
}

/**
 * The official bundle (gemini.js) starts a copy of itself as a child unless this is set. On Windows
 * killing our direct child would leave that copy running with the stdout pipe open, so every start
 * of the CLI (the turn and `--version`) sets it.
 */
export const GEMINI_NO_RELAUNCH_ENV: Readonly<Record<string, string>> = { GEMINI_CLI_NO_RELAUNCH: "1" };

/** The official bundle script is started by `node`; anything else is started as it is. */
export function isGeminiBundleScript(binary: string): boolean {
	return path.win32.basename(binary).toLowerCase() === BUNDLE_SCRIPT_NAME;
}

export function findNodeBinary(): string | null {
	return resolveCliBinary(nodeBinarySpec, { env: process.env, platform: process.platform, homeDir: os.homedir(), isExecutable: isExecutableFile });
}

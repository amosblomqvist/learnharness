import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (path: string) => boolean;
};

export type CliBinarySpec = {
	windowsNames: string[];
	posixNames: string[];
	knownDirs: (lookup: BinaryLookup, paths: path.PlatformPath) => string[];
	excludedExtensions: string[];
};

function getWindowsKnownDirs(env: BinaryLookup["env"], homeDir: string): string[] {
	const paths = path.win32;
	const appData = env.APPDATA ?? paths.join(homeDir, "AppData", "Roaming");

	return [
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".claude", "local"),
			env.npm_config_prefix ?? paths.join(appData, "npm"),
	];
}

function getPosixKnownDirs(env: BinaryLookup["env"], homeDir: string): string[] {
	const paths = path.posix;
	const npmBin = env.npm_config_prefix
		? paths.join(env.npm_config_prefix, "bin")
		: paths.join(homeDir, ".npm-global", "bin");

	return [
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".claude", "local"),
			npmBin,
			"/opt/homebrew/bin",
			"/usr/local/bin",
	];
}

const claudeBinarySpec: CliBinarySpec = {
	windowsNames: ["claude.exe"],
	posixNames: ["claude"],
	knownDirs: ({ env, platform, homeDir }) => platform === "win32"
		? getWindowsKnownDirs(env, homeDir) : getPosixKnownDirs(env, homeDir),
	// Direct spawn uses no shell, so npm's .cmd-only installation cannot run.
	excludedExtensions: [".cmd", ".bat"],
};

export function resolveCliBinary(spec: CliBinarySpec, lookup: BinaryLookup): string | null {
	const { env, platform, cwd = process.cwd(), isExecutable } = lookup;
	const paths = platform === "win32" ? path.win32 : path.posix;
	const names = platform === "win32"
		? [...new Set(spec.windowsNames.flatMap((name) => {
			const base = name.slice(0, name.length - paths.extname(name).length);
			return [name, `${base}.exe`, `${base}.cmd`, `${base}.bat`];
		}))]
		: spec.posixNames;
	const knownDirs = spec.knownDirs(lookup, paths);

	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);

	for (const name of names) {
		if (spec.excludedExtensions.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase()))) continue;
		for (const dir of [...pathDirs, ...knownDirs]) {
			// Discovery is relative to the server cwd; probes/model work use
			// different directories and must receive the same absolute identity.
			const candidate = paths.resolve(cwd, dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}

	return null;
}

export function resolveClaudeBinary(lookup: BinaryLookup): string | null {
	return resolveCliBinary(claudeBinarySpec, lookup);
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getClaudeBinary(): string | null {
	return getCliBinary(claudeBinarySpec);
}

export function getCliBinary(spec: CliBinarySpec): string | null {
	return resolveCliBinary(spec, {
		env: process.env,
		platform: process.platform,
		homeDir: os.homedir(),
		isExecutable: isExecutableFile,
	});
}

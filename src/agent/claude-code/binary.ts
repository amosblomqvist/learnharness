import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (path: string) => boolean;
};

type SearchSpec = {
	paths: path.PlatformPath;
	names: string[];
	knownDirs: string[];
};

function getWindowsSearchSpec(env: BinaryLookup["env"], homeDir: string): SearchSpec {
	const paths = path.win32;
	const appData = env.APPDATA ?? paths.join(homeDir, "AppData", "Roaming");

	return {
		paths,
		// Direct spawn deliberately uses no shell. A .cmd-only npm install
		// is not runnable and must not count as an available provider.
		names: ["claude.exe"],
		knownDirs: [
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".claude", "local"),
			env.npm_config_prefix ?? paths.join(appData, "npm"),
		],
	};
}

function getPosixSearchSpec(env: BinaryLookup["env"], homeDir: string): SearchSpec {
	const paths = path.posix;
	const npmBin = env.npm_config_prefix
		? paths.join(env.npm_config_prefix, "bin")
		: paths.join(homeDir, ".npm-global", "bin");

	return {
		paths,
		names: ["claude"],
		knownDirs: [
			paths.join(homeDir, ".local", "bin"),
			paths.join(homeDir, ".claude", "local"),
			npmBin,
			"/opt/homebrew/bin",
			"/usr/local/bin",
		],
	};
}

export function resolveClaudeBinary({ env, platform, homeDir, cwd = process.cwd(), isExecutable }: BinaryLookup): string | null {
	const { paths, names, knownDirs } = platform === "win32"
		? getWindowsSearchSpec(env, homeDir)
		: getPosixSearchSpec(env, homeDir);

	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);

	for (const name of names) {
		for (const dir of [...pathDirs, ...knownDirs]) {
			// Discovery is relative to the server cwd; probes/model work use
			// different directories and must receive the same absolute identity.
			const candidate = paths.resolve(cwd, dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}

	return null;
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
	return resolveClaudeBinary({
		env: process.env,
		platform: process.platform,
		homeDir: os.homedir(),
		isExecutable: isExecutableFile,
	});
}

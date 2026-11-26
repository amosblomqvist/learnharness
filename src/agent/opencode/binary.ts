import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function resolveOpenCodeBinary(options: {
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	homeDir?: string;
	cwd?: string;
	isExecutable?: (path: string) => boolean;
} = {}): string | null {
	const { env = process.env, platform = process.platform, homeDir = os.homedir(), cwd = process.cwd() } = options;
	const executableCheck = options.isExecutable ?? ((candidate: string) => {
		try { return fs.statSync(candidate).isFile() && fs.accessSync(candidate, fs.constants.X_OK) === undefined; } catch { return false; }
	});
	const paths = platform === "win32" ? path.win32 : path.posix;
	const names = platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"];
	const knownDirs = platform === "win32"
		? [paths.join(homeDir, ".local", "bin")]
		: [paths.join(homeDir, ".local", "bin"), paths.join(homeDir, ".opencode", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	for (const name of names) {
		for (const dir of [...pathDirs, ...knownDirs]) {
			const candidate = paths.resolve(cwd, dir, name);
			if (executableCheck(candidate) && !candidate.endsWith(".cmd")) return candidate;
		}
	}
	return null;
}

export function getOpenCodeBinary(): string | null {
	return resolveOpenCodeBinary();
}

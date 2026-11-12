import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function getAntigravityBinary(env: NodeJS.ProcessEnv = process.env): string | null {
	const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	if (process.platform === "win32") dirs.push(path.join(env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "agy", "bin"));
	const candidates = env.LH_AGY_BINARY ? [path.resolve(env.LH_AGY_BINARY)] : dirs.map((dir) => path.resolve(dir, process.platform === "win32" ? "agy.exe" : "agy"));
	for (const file of candidates) {
		try {
			accessSync(file, constants.X_OK);
			if (statSync(file).isFile()) return file;
		} catch { /* Try the next installation directory. */ }
	}
	return null;
}

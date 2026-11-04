import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** GUI-launched desktop apps may not inherit the user's interactive PATH. */
export function codexBinary(): string {
	const home = homedir();
	const windows = process.platform === "win32";
	const candidates = [
		...(process.env.PATH ?? "").split(path.delimiter),
		path.join(home, ".local", "bin"),
		...(windows ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin")]),
	];
	for (const directory of candidates) {
		if (!directory) continue;
		const candidate = path.resolve(directory, windows ? "codex.exe" : "codex");
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch { /* Try the next directory. */ }
	}
	return "codex";
}

import * as path from "node:path";

/**
 * Point every home-folder variable at `dir`, so code under test never reaches
 * the real user profile (N4 R2, settled 14-11-2026). HOME alone is not enough
 * on Windows: os.homedir() reads USERPROFILE, and app data lives under
 * APPDATA and LOCALAPPDATA. Returns a function that puts all four back.
 */
const HOME_VARS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] as const;

export function redirectHome(dir: string): () => void {
	const saved = HOME_VARS.map((name) => [name, process.env[name]] as const);
	Object.assign(process.env, {
		HOME: dir,
		USERPROFILE: dir,
		APPDATA: path.join(dir, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(dir, "AppData", "Local"),
	});
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

import * as fs from "node:fs";
import * as path from "node:path";
import { PLUGIN_ID_PATTERN } from "../core/plugins.ts";

export interface CorePluginDataLocation { directory: string; ids: readonly string[] }

/** One origin-aware mapping shared by backend activation and crash recovery.
 * No package code, filesystem fallback, or old core data participates. */
export function safePluginDataDirectory(communityDirectory: string, id: string, core?: CorePluginDataLocation, create = false): string | null {
	if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("Invalid plugin id");
	const isCore = core?.ids.includes(id) === true;
	const root = path.resolve(/* turbopackIgnore: true */ isCore ? core!.directory : communityDirectory);
	const plugin = path.join(/* turbopackIgnore: true */ root, id);
	const directories = isCore ? [root, plugin] : [root, plugin, path.join(/* turbopackIgnore: true */ plugin, "data")];
	let realRoot: string | undefined;
	for (const directory of directories) {
		let stat: fs.Stats;
		try { stat = fs.lstatSync(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!create) return null;
			fs.mkdirSync(directory, { recursive: directory === root }); stat = fs.lstatSync(directory);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe plugin data directory: ${directory}`);
		const real = fs.realpathSync(/* turbopackIgnore: true */ directory); realRoot ??= real;
		const relative = path.relative(realRoot, real);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Plugin data directory escapes root");
	}
	return directories.at(-1)!;
}

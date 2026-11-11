/** Copy a built community package into an explicit plugins directory.
 * Portable: Node built-ins only. Run the project's build before this helper.
 * The host, not this helper, decides app compatibility and plugin enablement. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function directoryRoot(input) {
	const absolute = path.resolve(input);
	const stat = fs.lstatSync(absolute);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error(`Refusing non-directory or symlink root: ${absolute}`);
	// Resolve OS aliases above the explicitly supplied root (e.g. macOS /tmp).
	return fs.realpathSync(absolute);
}
function admit(root, filename, kind, optional = false) {
	const relative = path.relative(root, filename);
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error(`Refusing path outside root: ${filename}`);
	let current = root;
	const parts = relative ? ["", ...relative.split(path.sep)] : [""];
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]);
		const stat = fs.lstatSync(current, { throwIfNoEntry: false });
		if (!stat && optional) return false;
		if (!stat) throw Error(`Missing package path: ${current}`);
		if (stat.isSymbolicLink()) throw Error(`Refusing symlink: ${current}`);
		const directory = index < parts.length - 1 || kind === "directory";
		if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error(`Refusing non-${directory ? "directory" : "file"}: ${current}`);
	}
	return true;
}
function packageFiles(root, directory) {
	admit(root, directory, "directory");
	return fs.readdirSync(directory).sort().flatMap(name => {
		const filename = path.join(directory, name);
		const stat = fs.lstatSync(filename);
		if (stat.isSymbolicLink()) throw Error(`Refusing package symlink: ${filename}`);
		if (["data", "node_modules", ".git"].includes(name) || /^(?:\.env(?:\..*)?|auth\.json|.*-credentials\.json.*)$/.test(name)) throw Error(`Refusing non-distributable package entry: ${filename}`);
		if (stat.isDirectory()) return packageFiles(root, filename);
		admit(root, filename, "file");
		return [filename];
	});
}
function manifest(root, dist) {
	const filename = path.join(dist, "manifest.json");
	admit(root, filename, "file");
	const value = JSON.parse(fs.readFileSync(filename, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)) throw Error("Invalid plugin manifest id");
	if (value.apiVersion !== 1) throw Error("Expected plugin apiVersion 1");
	if (typeof value.name !== "string" || !value.name.trim()) throw Error("Manifest name is required");
	for (const key of ["version", "minAppVersion"]) if (typeof value[key] !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value[key])) throw Error(`Manifest ${key} must be a numeric x.y.z version`);
	for (const key of ["description", "author"]) if (value[key] !== undefined && typeof value[key] !== "string") throw Error(`Manifest ${key} must be a string`);
	for (const [key, extension] of [["main", ".js"], ["backend", ".cjs"], ["styles", ".css"]]) {
		if (value[key] === undefined) continue;
		if (typeof value[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value[key]) || !value[key].endsWith(extension)) throw Error(`Manifest ${key} must name a root ${extension} file`);
		admit(root, path.join(dist, value[key]), "file");
	}
	if (!value.main && !value.backend) throw Error("A plugin needs a main or backend entry");
	if (value.styles && !value.main) throw Error("styles requires a frontend main entry");
	return value;
}
function inside(parent, child) {
	const relative = path.relative(parent, child);
	return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function targetDist(root, plugin) {
	admit(root, plugin, "directory", true);
	const dist = path.join(plugin, "dist");
	const exists = admit(root, dist, "directory", true);
	// Never delete misplaced data, including dangling links or non-directory entries.
	if (fs.lstatSync(path.join(dist, "data"), { throwIfNoEntry: false })) throw Error(`Refusing misplaced dist/data: ${dist}`);
	return exists;
}

export function installPluginLocal({ project = process.cwd(), pluginsDirectory }) {
	if (typeof pluginsDirectory !== "string" || !pluginsDirectory.trim()) throw Error("An explicit plugins directory is required");
	const sourceRoot = directoryRoot(project), destinationRoot = directoryRoot(pluginsDirectory);
	const source = path.join(sourceRoot, "dist");
	const entries = packageFiles(sourceRoot, source);
	const pkg = manifest(sourceRoot, source);
	const plugin = path.join(destinationRoot, pkg.id), destination = path.join(plugin, "dist");
	if (source === destination) return { id: pkg.id, directory: destination, copied: false };
	if (inside(source, destination) || inside(destination, source)) throw Error("Refusing overlapping source and destination dist directories");
	targetDist(destinationRoot, plugin);
	fs.mkdirSync(plugin, { recursive: true });
	admit(destinationRoot, plugin, "directory");
	const stage = fs.mkdtempSync(path.join(plugin, ".install-"));
	const next = path.join(stage, "next"), previous = path.join(stage, "previous");
	let movedOld = false, installed = false, keepBackup = false;
	try {
		fs.mkdirSync(next);
		for (const filename of entries) {
			admit(sourceRoot, filename, "file");
			const output = path.join(next, path.relative(source, filename));
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.copyFileSync(filename, output);
		}
		// Finish admission before touching installed code, including a recheck after staging.
		manifest(stage, next);
		if (targetDist(destinationRoot, plugin)) { fs.renameSync(destination, previous); movedOld = true; }
		fs.renameSync(next, destination);
		installed = true;
		return { id: pkg.id, directory: destination, copied: true };
	} catch (error) {
		if (movedOld && !installed) {
			try { fs.renameSync(previous, destination); }
			catch (rollbackError) {
				keepBackup = true;
				throw new Error(`Installation failed and rollback failed. Previous dist preserved at ${previous}: ${rollbackError.message}`, { cause: error });
			}
		}
		throw error;
	} finally {
		if (!keepBackup) fs.rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		if (process.argv.length !== 3 || !process.argv[2].trim()) throw Error('Usage: node scripts/install-plugin-local.mjs "<plugins-directory>" (run after building)');
		const result = installPluginLocal({ pluginsDirectory: process.argv[2] });
		console.log(`[plugin-install] ${result.copied ? "Installed" : "Already built in place"}: ${result.directory}`);
		console.log("Refresh Community plugins and enable new plugins. Restart LearnHarness to load changes to already-loaded code.");
	} catch (error) { console.error("[plugin-install]", error.message); process.exitCode = 1; }
}

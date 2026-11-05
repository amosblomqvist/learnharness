import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_ID_PATTERN, parsePluginManifest } from "../core/plugins.ts";

// Ownership and journal file paths are relative to each plugin's fixed dist/ code root.
interface Ownership { version: 1; plugins: Record<string, { files: string[] }> }
interface Installing { version: 1; id: string; files: string[] }
export interface BundledPluginInstallationReport { errors: Record<string, string> }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
const metadataPath = (directory: string) => path.resolve(/* turbopackIgnore: true */ directory, "..", "plugins-bundled.json");
const markersPath = (directory: string) => path.resolve(/* turbopackIgnore: true */ directory, "..", "plugins-installing");
const markerPath = (directory: string, id: string) => path.join(/* turbopackIgnore: true */ markersPath(directory), `${id}.json`);

function validFile(file: unknown): file is string {
	if (typeof file !== "string") return false;
	const parts = file.split("/");
	return (parts.length === 1 || parts[0] === "assets") && parts.every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p) && p !== "data");
}
function fileList(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(validFile) || new Set(value).size !== value.length) throw new Error("Invalid bundled plugin file ownership");
	return value;
}
function readOwnership(directory: string): Ownership {
	const filename = metadataPath(directory);
	if (!exists(filename)) return { version: 1, plugins: Object.create(null) };
	if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error("Unsafe bundled plugin metadata");
	const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filename, "utf8"));
	if (!record(value) || value.version !== 1 || !record(value.plugins)) throw new Error("Invalid or unsupported plugins-bundled.json");
	const plugins: Ownership["plugins"] = Object.create(null);
	for (const [id, entry] of Object.entries(value.plugins)) {
		if (!PLUGIN_ID_PATTERN.test(id) || !record(entry)) throw new Error("Invalid bundled plugin ownership");
		plugins[id] = { files: fileList(entry.files) };
	}
	return { version: 1, plugins };
}
function readMarker(directory: string, id: string): Installing | undefined {
	const filename = markerPath(directory, id);
	if (!exists(filename)) return;
	const stat = fs.lstatSync(filename);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe installation marker for ${id}`);
	const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filename, "utf8"));
	if (!record(value) || value.version !== 1 || value.id !== id) throw new Error(`Invalid installation marker for ${id}`);
	return { version: 1, id, files: fileList(value.files) };
}

/** A marker blocks activation even when a first installation has no manifest yet. */
export function pendingBundledPluginIds(directory: string): string[] {
	const markers = markersPath(directory);
	if (!exists(markers)) return [];
	if (!fs.lstatSync(markers).isDirectory() || fs.lstatSync(markers).isSymbolicLink()) throw new Error("Unsafe plugin installation markers directory");
	return fs.readdirSync(/* turbopackIgnore: true */ markers).filter(f => f.endsWith(".json")).map(f => {
		const id = f.slice(0, -5);
		if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("Invalid plugin installation marker name");
		// Even malformed markers must block loading; only the installer parses them.
		return id;
	}).sort();
}

function directory(p: string): void {
	if (!exists(p)) fs.mkdirSync(p, { recursive: true });
	if (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink()) throw new Error(`Unsafe plugin directory: ${p}`);
}
/**
 * Node cannot portably open/flush Windows directory handles. Skip directory
 * fsync only on win32; file fsync + rename still run on every platform. POSIX
 * open/fsync failures (including EIO/EACCES) must remain visible, not ignored.
 * The narrow platform/IO seam permits branch tests without claiming Windows E2E.
 */
export function syncPluginInstallationDirectory(p: string, options: {
	platform?: NodeJS.Platform;
	io?: Pick<typeof fs, "openSync" | "fsyncSync" | "closeSync">;
} = {}): void {
	if ((options.platform ?? process.platform) === "win32") return;
	const io = options.io ?? fs;
	const fd = io.openSync(p, "r");
	try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
/** Same-directory rename: file fsync everywhere, directory fsync on POSIX. */
function atomicWrite(filename: string, bytes: string | Uint8Array): void {
	const temp = path.join(path.dirname(filename), `.plugin-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = undefined;
		fs.renameSync(temp, filename);
		syncPluginInstallationDirectory(path.dirname(filename));
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (exists(temp)) fs.unlinkSync(temp);
	}
}
function checkedTarget(root: string, relative: string): string {
	if (!validFile(relative)) throw new Error(`Unsafe package file: ${relative}`);
	const parts = relative.split("/");
	let parent = root;
	for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); directory(parent); }
	const target = path.join(parent, parts.at(-1)!);
	if (exists(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error(`Unsafe package target: ${target}`);
	return target;
}
function stage(source: string, id: string, appVersion: string): Map<string, Buffer> {
	if (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`Unsafe bundled package: ${id}`);
	const files = new Map<string, Buffer>();
	function walk(relative: string): void {
		const absolute = path.join(/* turbopackIgnore: true */ source, relative);
		for (const name of fs.readdirSync(/* turbopackIgnore: true */ absolute).sort()) {
			const file = relative ? `${relative}/${name}` : name;
			if (!validFile(file)) throw new Error(`Reserved or invalid bundled package path: ${id}/${file}`);
			const stat = fs.lstatSync(path.join(/* turbopackIgnore: true */ source, file));
			if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in bundled packages: ${file}`);
			if (stat.isDirectory() && (file === "assets" || file.startsWith("assets/"))) walk(file);
			else if (stat.isFile()) files.set(file, fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ source, file)));
			else throw new Error(`Only root files and assets are allowed: ${file}`);
		}
	}
	walk("");
	const manifest = files.get("manifest.json");
	if (!manifest) throw new Error(`Missing bundled manifest: ${id}`);
	const parsed = parsePluginManifest(JSON.parse(manifest.toString("utf8")), id, appVersion);
	for (const entry of [parsed.main, parsed.backend, parsed.styles]) if (entry && !files.has(entry)) throw new Error(`Missing bundled entry: ${id}/${entry}`);
	return files;
}

/**
 * Startup-only: invoke BEFORE initializing the host, passing report.errors as
 * its installationErrors dependency (creating the host itself does no IO).
 * Package failures are isolated; unsafe
 * global ownership/source metadata still throws. A write-ahead marker precedes
 * all package mutation. File fsync + rename run everywhere; POSIX also fsyncs
 * directory entries. Node cannot flush directory entries on Windows, so power-
 * loss durability there is filesystem-dependent. Startup retry repairs partial
 * dist/ code updates (including obsolete owned files); sibling data/ and project
 * files outside dist/ are never read or written.
 * This is recoverable, not a whole-package atomic swap or a live updater.
 */
export function installBundledPlugins(sourceDir: string, pluginsDir: string, appVersion: string): BundledPluginInstallationReport {
	// Bundled packages are explicitly copied by build-server, not fs tracing.
	const source = path.resolve(/* turbopackIgnore: true */ sourceDir), destination = path.resolve(/* turbopackIgnore: true */ pluginsDir);
	if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) throw new Error("Bundled source and destination must be separate");
	if (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error("Unsafe bundled source directory");
	const errors: Record<string, string> = Object.create(null);
	const fail = (id: string, error: unknown) => { errors[id] = error instanceof Error ? error.message : String(error); };
	// Validate/stage each package completely before any installed code is touched.
	const sourceIds = fs.readdirSync(/* turbopackIgnore: true */ source).sort();
	const packages: { id: string; files: Map<string, Buffer> }[] = [];
	for (const id of sourceIds) {
		try {
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`Invalid bundled plugin folder: ${id}`);
			packages.push({ id, files: stage(path.join(source, id), id, appVersion) });
		} catch (e) { fail(id, e); }
	}
	const ownership = readOwnership(destination);
	directory(destination);
	directory(markersPath(destination));
	syncPluginInstallationDirectory(path.dirname(destination)); // Persist a newly created markers directory where supported.
	for (const id of pendingBundledPluginIds(destination)) {
		if (!sourceIds.includes(id)) fail(id, new Error(`Incomplete bundled installation ${id} has no source package to retry`));
	}
	for (const { id, files } of packages) {
		try {
			const pluginRoot = path.join(destination, id), root = path.join(pluginRoot, "dist");
			const pending = readMarker(destination, id);
			const owned = Object.hasOwn(ownership.plugins, id) ? ownership.plugins[id] : undefined;
			if (exists(pluginRoot) && !Object.hasOwn(ownership.plugins, id) && !pending) throw new Error(`Bundled plugin ${id} collides with an external installation`);
			if (exists(pluginRoot) && (!fs.lstatSync(pluginRoot).isDirectory() || fs.lstatSync(pluginRoot).isSymbolicLink())) throw new Error(`Unsafe installed package: ${id}`);
			const previous = [...new Set([...(owned?.files ?? []), ...(pending?.files ?? [])])];
			const next = [...files.keys()].sort();
			// This write-ahead journal also establishes ownership on an interrupted first install.
			atomicWrite(markerPath(destination, id), JSON.stringify({ version: 1, id, files: [...new Set([...previous, ...next])].sort() } satisfies Installing));
			directory(pluginRoot);
			syncPluginInstallationDirectory(destination);
			directory(root);
			syncPluginInstallationDirectory(pluginRoot);
			// Validate ALL destinations before replacing the first code file.
			for (const file of new Set([...previous, ...next])) checkedTarget(root, file);
			for (const file of next) if (file !== "manifest.json") atomicWrite(checkedTarget(root, file), files.get(file)!);
			for (const file of previous) if (!files.has(file)) {
				const target = checkedTarget(root, file);
				if (exists(target)) { fs.unlinkSync(target); syncPluginInstallationDirectory(path.dirname(target)); }
			}
			atomicWrite(checkedTarget(root, "manifest.json"), files.get("manifest.json")!);
			// Publish ownership only after its atomic metadata write succeeds.
			const updated: Ownership = { version: 1, plugins: Object.assign(Object.create(null), ownership.plugins, { [id]: { files: next } }) };
			atomicWrite(metadataPath(destination), JSON.stringify(updated));
			ownership.plugins = updated.plugins;
			fs.unlinkSync(markerPath(destination, id));
			syncPluginInstallationDirectory(markersPath(destination));
		} catch (e) { fail(id, e); }
	}
	return { errors };
}

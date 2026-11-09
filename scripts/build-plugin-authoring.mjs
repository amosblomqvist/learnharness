/** Build the complete offline authoring skill. No runtime/plugin discovery or learner data. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

export const AUTHORING_DOCS = [
	"plugin-authoring.md", "plugin-architecture.md", "plugin-question-contract.md",
	"plugin-problem-contract.md", "plugin-session-extension-contract.md", "plugin-tree-contract.md",
	"plugin-view-context.md", "dialog-overlay-contract.md", "archive/plugin-implementation-history.md",
];
export const AUTHORING_EXAMPLES = ["hello-plugin", "managed-agent", "teaching-extension"];
export const AUTHORING_ZIP = "learnharness-plugins.zip";

/** Admit every component below the intended source root before dereferencing it.
 * Final-component checks alone miss linked parent directories. */
function sourcePath(root, source, kind) {
	root = path.resolve(root);
	const filename = path.resolve(source), relative = path.relative(root, filename);
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error(`Refusing authoring source outside root: ${filename}`);
	let current = root;
	const components = relative ? ["", ...relative.split(path.sep)] : [""];
	for (let index = 0; index < components.length; index++) {
		current = path.join(current, components[index]);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw Error(`Refusing authoring source symlink: ${current}`);
		const directory = index < components.length - 1 || kind === "directory";
		if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error(`Refusing non-${directory ? "directory" : "file"} authoring source: ${current}`);
	}
	return filename;
}
function files(directory, prefix = "", root = directory) {
	return fs.readdirSync(sourcePath(root, directory, "directory"), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")).flatMap(entry => {
		const relative = prefix + entry.name, filename = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw Error(`Refusing authoring symlink: ${filename}`);
		if (entry.isDirectory()) {
			if (["data", "node_modules", ".git"].includes(entry.name)) throw Error(`Refusing non-authoring directory: ${filename}`);
			return files(filename, relative + "/", root);
		}
		if (!entry.isFile() || /^(?:\.env(?:\..*)?|auth\.json|.*-credentials\.json.*)$/.test(entry.name)) throw Error(`Refusing non-authoring file: ${filename}`);
		return [{ name: relative, data: fs.readFileSync(sourcePath(root, filename, "file")) }];
	});
}

/** Deterministic ZIP32, stored entries: this text-only kit is small (~0.5 MiB).
 * Fixed DOS date, UTF-8 names and regular-file attributes; no platform zip executable. */
export function createAuthoringZip(entries) {
	if (entries.length > 65535) throw Error("Too many authoring ZIP entries");
	const local = [], central = [], names = new Set();
	let offset = 0;
	for (const { name, data } of entries) {
		if (!name.startsWith("learnharness-plugins/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || names.has(name)) throw Error(`Invalid authoring ZIP path: ${name}`);
		names.add(name);
		const filename = Buffer.from(name), bytes = Buffer.from(data);
		if (filename.length > 65535 || bytes.length >= 0xffffffff || offset >= 0xffffffff) throw Error("Authoring ZIP32 limit exceeded");
		const checksum = crc32(bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
		header.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00
		header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
		local.push(header, filename, bytes);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(33, 14);
		record.writeUInt32LE(checksum, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28);
		record.writeUInt32LE(0o100644 * 65536, 38); record.writeUInt32LE(offset, 42);
		central.push(record, filename);
		offset += header.length + filename.length + bytes.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	if (offset + directory.length >= 0xffffffff) throw Error("Authoring ZIP32 limit exceeded");
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

function copyFile(root, source, destination) {
	const admitted = sourcePath(root, source, "file");
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(admitted, destination);
}
function copyDirectory(root, source, destination) {
	for (const entry of files(source, "", root)) {
		const filename = path.join(destination, entry.name);
		fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, entry.data);
	}
}
function ownedOutput(root, destination) {
	const relative = path.relative(root, destination);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !relative || !["dist", ".next", "public"].includes(relative.split(path.sep)[0]) || relative.split(path.sep).length < 2) throw Error(`Refusing unsafe authoring output: ${destination}`);
	let current = root;
	for (const part of relative.split(path.sep)) {
		current = path.join(current, part);
		if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error(`Refusing symlinked authoring output: ${current}`);
	}
}

export function buildPluginAuthoring({ root = path.resolve(import.meta.dirname, ".."), standalone = false } = {}) {
	const base = standalone ? path.join(root, ".next", "standalone") : root;
	const directory = path.join(base, standalone ? "plugin-authoring" : "dist/plugin-authoring");
	const publicDirectory = path.join(base, "public", "plugin-authoring");
	ownedOutput(root, directory); ownedOutput(root, publicDirectory);
	const app = JSON.parse(fs.readFileSync(sourcePath(root, path.join(root, "package.json"), "file"), "utf8"));
	if (!/^\d+\.\d+\.\d+$/.test(app.version)) throw Error("Authoring requires a numeric app version");
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "lh-authoring-"));
	try {
		copyFile(root, path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
		for (const filename of AUTHORING_DOCS) copyFile(root, path.join(root, "docs", filename), path.join(stage, "docs", filename));
		for (const id of AUTHORING_EXAMPLES) {
			const source = path.join(root, "examples", "plugins", id), destination = path.join(stage, "examples", "plugins", id);
			copyFile(root, path.join(source, "README.md"), path.join(destination, "README.md"));
			copyDirectory(root, path.join(source, "dist"), path.join(destination, "dist"));
			const manifestPath = path.join(destination, "dist", "manifest.json"), manifest = JSON.parse(fs.readFileSync(sourcePath(stage, manifestPath, "file"), "utf8"));
			if (manifest.id !== id || manifest.apiVersion !== 1) throw Error(`Invalid authoring example: ${id}`);
			manifest.minAppVersion = app.version;
			fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
		}
		// Maintainer tests remain in the checkout, not the installable examples.
		const skill = fs.readFileSync(sourcePath(root, path.join(root, "skills", "learnharness-plugins", "SKILL.md"), "file"), "utf8").replaceAll("../../docs/", "./docs/").replaceAll("../../examples/", "./examples/");
		fs.writeFileSync(path.join(stage, "SKILL.md"), skill);
		copyFile(root, path.join(root, "skills", "learnharness-plugins", "README.md"), path.join(stage, "README.md"));
		const types = spawnSync(process.execPath, [sourcePath(root, path.join(root, "scripts", "build-plugin-types.mjs"), "file"), path.join(stage, "types")], { cwd: root, stdio: "inherit" });
		if (types.error || types.status !== 0) throw Error(`Authoring API declaration emission failed: ${types.error ?? types.status}`);
		const sdk = JSON.parse(fs.readFileSync(sourcePath(stage, path.join(stage, "types", "package.json"), "file"), "utf8"));
		const metadata = { appVersion: app.version, pluginApiVersion: 1, sdkVersion: sdk.version };
		fs.writeFileSync(path.join(stage, "bundle.json"), JSON.stringify(metadata, null, "\t") + "\n");
		const entries = files(stage).map(entry => ({ ...entry, name: "learnharness-plugins/" + entry.name }));
		const archive = createAuthoringZip(entries);
		fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true });
		fs.cpSync(stage, directory, { recursive: true });
		fs.mkdirSync(publicDirectory, { recursive: true });
		const output = path.join(publicDirectory, AUTHORING_ZIP);
		if (fs.lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error(`Refusing symlinked authoring ZIP: ${output}`);
		fs.writeFileSync(output, archive);
		console.log("[plugin-authoring] complete skill ready:", output);
		return { directory, archive: output, metadata, entries: entries.length };
	} finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	if (process.argv.slice(2).some(argument => argument !== "--standalone")) throw Error("Usage: node scripts/build-plugin-authoring.mjs [--standalone]");
	buildPluginAuthoring({ standalone: process.argv.includes("--standalone") });
}

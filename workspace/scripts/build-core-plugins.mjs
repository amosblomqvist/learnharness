/** Build app-owned packages only. Never installs into a learning-data profile. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePluginManifest, PLUGIN_ID_PATTERN } from "../src/core/plugins.ts";

const exists = filename => { try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
function directory(filename) {
	const stat = fs.lstatSync(filename);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe Core plugin directory: ${filename}`);
}
export function readCoreCatalog(root) {
	const filename = path.join(root, "core-plugins.json");
	if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error("Unsafe Core plugin catalog");
	const ids = JSON.parse(fs.readFileSync(filename, "utf8"));
	if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid Core plugin catalog");
	return ids;
}
function safeTree(root) {
	directory(root);
	function visit(current) {
		for (const name of fs.readdirSync(current)) {
			if (/^(data|core-plugin-data|node_modules|src|tests|\.sdk|\.git)$/.test(name) || /^(\.env($|\.)|auth\.json($|\.)|(chatgpt|github-copilot|xai)-credentials\.json)/.test(name) || /\.(ts|tsx)$/.test(name) || /^(package|package-lock)\.json$/.test(name)) throw new Error(`Refusing unsafe Core package content: ${path.join(current, name)}`);
			const filename = path.join(current, name), stat = fs.lstatSync(filename);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsafe Core package file: ${filename}`);
			if (stat.isDirectory()) visit(filename);
		}
	}
	visit(root);
}
function validatePackage(root, code, id) {
	safeTree(code);
	const appVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(code, "manifest.json"), "utf8")), id, appVersion);
	for (const entry of [manifest.main, manifest.backend, manifest.styles].filter(Boolean)) {
		if (!fs.lstatSync(path.join(code, entry)).isFile()) throw new Error(`Missing Core package entry: ${id}/${entry}`);
	}
}
export function validateCorePackages(root, packages) {
	directory(packages);
	const ids = readCoreCatalog(root);
	if (JSON.stringify(fs.readdirSync(packages).sort()) !== JSON.stringify([...ids].sort())) throw new Error("Core package directories do not match the catalog");
	for (const id of ids) validatePackage(root, path.join(packages, id), id);
}
function publicCodePermissions(root) {
	// A mkdtemp staging root is 0700; app code must also be readable by users
	// other than the build account. Never apply these modes to learner data.
	fs.chmodSync(root, 0o755);
	for (const name of fs.readdirSync(root)) {
		const file = path.join(root, name), stat = fs.lstatSync(file);
		if (stat.isDirectory()) publicCodePermissions(file);
		else fs.chmodSync(file, stat.mode & 0o111 ? 0o755 : 0o644);
	}
}
function runNpm(args, cwd) {
	if (!process.env.npm_execpath) throw new Error("Run through npm run plugins:build-core; run npm run plugins:setup first on a fresh checkout");
	const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(cwd)} build failed (${result.signal ?? result.status})`);
}
export function buildCorePlugins(root, { run = runNpm } = {}) {
	const ids = readCoreCatalog(root), source = path.join(root, "plugins"), out = path.join(root, "core-plugins");
	directory(source);
	if (exists(out)) safeTree(out); // Never clean away accidentally misplaced data or linked files.
	const staged = fs.mkdtempSync(path.join(root, ".core-plugins-build-"));
	const previous = path.join(root, `.core-plugins-backup-${randomUUID()}`);
	try {
		for (const id of ids) {
			const project = path.join(source, id), code = path.join(project, "dist");
			directory(project); if (exists(code)) safeTree(code);
			run(["run", "build"], project);
			validatePackage(root, code, id);
			fs.cpSync(code, path.join(staged, id), { recursive: true });
		}
		validateCorePackages(root, staged);
		publicCodePermissions(staged);
		const hadPrevious = exists(out);
		if (hadPrevious) fs.renameSync(out, previous);
		try { fs.renameSync(staged, out); }
		catch (error) { if (hadPrevious) fs.renameSync(previous, out); throw error; }
		if (hadPrevious) fs.rmSync(previous, { recursive: true });
		console.log(`[core-plugins] built ${ids.join(", ")} into ${out}`);
	} finally { if (exists(staged)) fs.rmSync(staged, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { buildCorePlugins(path.resolve(import.meta.dirname, "..")); }
	catch (error) { console.error("[core-plugins]", error); process.exitCode = 1; }
}

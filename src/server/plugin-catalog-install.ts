import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Open } from "unzipper";
import packageJson from "../../package.json";
import coreIds from "../../core-plugins.json";
import { parsePluginManifest } from "../core/plugins.ts";
import { comparePluginVersions, type CatalogPlugin } from "../core/plugin-catalog.ts";
import { getPluginHost, pluginDirectory } from "./plugins.ts";

const maxArchive = 30 * 1024 * 1024;
const maxExtracted = 100 * 1024 * 1024;
const maxEntries = 500;
const active = new Set<string>();

function safeDirectory(directory: string): void {
	const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
	if (!stat) fs.mkdirSync(directory);
	else if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`Unsafe plugin directory: ${directory}`);
}

async function download(entry: CatalogPlugin): Promise<Buffer> {
	let target = entry.releaseUrl;
	for (let redirect = 0; redirect < 5; redirect++) {
		const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "User-Agent": `LearnHarness/${packageJson.version}` }, cache: "no-store" });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			if (!location) throw Error("Release redirect has no location");
			const next = new URL(location, target);
			if (next.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname) || next.username || next.password) throw Error("Release redirect left approved GitHub hosts");
			target = next.href;
			continue;
		}
		if (!response.ok || !response.body) throw Error(`Release download failed (${response.status})`);
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > maxArchive) throw Error("Plugin ZIP exceeds download limit");
		const chunks: Buffer[] = [];
		let size = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = Buffer.from(value);
				size += chunk.length;
				if (size > maxArchive) throw Error("Plugin ZIP exceeds download limit");
				chunks.push(chunk);
			}
		} finally { reader.releaseLock(); }
		const bytes = Buffer.concat(chunks);
		if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw Error("Plugin ZIP does not match catalog SHA-256");
		return bytes;
	}
	throw Error("Too many release redirects");
}

export async function extractCatalogZip(bytes: Buffer, destination: string): Promise<void> {
	const archive = await Open.buffer(bytes);
	if (archive.files.length === 0 || archive.files.length > maxEntries) throw Error("Invalid plugin ZIP entry count");
	const seen = new Set<string>();
	let declared = 0, actual = 0;
	for (const file of archive.files) {
		const name = file.path;
		const normalized = file.type === "Directory" && name.endsWith("/") ? name.slice(0, -1) : name;
		const parts = normalized.split("/");
		if (!name.startsWith("dist/") || name.includes("\\") || name.includes("\0") || parts.some(part => !part || part === ".." || part === ".") || (file.type === "File" && name.endsWith("/"))) throw Error(`Unsafe plugin ZIP path: ${name}`);
		if (parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error(`Unsupported plugin ZIP filename: ${name}`);
		if (parts.some(part => ["data", "node_modules", ".git"].includes(part) || /^(?:\.env(?:\..*)?|auth\.json|.*-credentials\.json.*)$/i.test(part))) throw Error(`Non-distributable plugin ZIP entry: ${name}`);
		const key = name.toLowerCase();
		if (seen.has(key)) throw Error(`Duplicate plugin ZIP entry: ${name}`);
		seen.add(key);
		const unixType = (file.externalFileAttributes >>> 16) & 0xf000;
		if (unixType && unixType !== (file.type === "Directory" ? 0x4000 : 0x8000)) throw Error(`Unsupported plugin ZIP entry: ${name}`);
		if (file.type === "Directory") continue;
		if (!Number.isSafeInteger(file.uncompressedSize) || file.uncompressedSize < 0 || file.uncompressedSize > maxArchive) throw Error(`Oversized plugin ZIP entry: ${name}`);
		declared += file.uncompressedSize;
		if (declared > maxExtracted) throw Error("Plugin ZIP exceeds extracted size limit");
		const output = path.join(destination, ...parts.slice(1));
		fs.mkdirSync(path.dirname(output), { recursive: true });
		const handle = fs.openSync(output, "wx");
		let written = 0;
		try {
			for await (const chunk of file.stream()) {
				const data = Buffer.from(chunk);
				written += data.length; actual += data.length;
				if (written > file.uncompressedSize || actual > maxExtracted) throw Error("Plugin ZIP decompressed beyond limit");
				let offset = 0;
				while (offset < data.length) offset += fs.writeSync(handle, data, offset);
			}
		} finally { fs.closeSync(handle); }
		if (written !== file.uncompressedSize) throw Error(`Incomplete plugin ZIP entry: ${name}`);
	}
}

/** Atomically replace code while keeping sibling data; caller owns staging cleanup. */
export async function replacePluginDist(plugin: string, next: string, afterInstall: () => Promise<void>): Promise<void> {
	const dist = path.join(plugin, "dist"), previous = path.join(path.dirname(next), "previous");
	const existing = fs.lstatSync(dist, { throwIfNoEntry: false });
	if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw Error("Unsafe existing plugin package");
	let movedOld = false, movedNew = false;
	try {
		if (existing) { fs.renameSync(dist, previous); movedOld = true; }
		fs.renameSync(next, dist); movedNew = true;
		await afterInstall();
	} catch (error) {
		try {
			if (movedNew) fs.renameSync(dist, next);
			if (movedOld) fs.renameSync(previous, dist);
		} catch (rollbackError) {
			throw new Error(`Installation and rollback failed; previous code is preserved at ${previous}: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`, { cause: error });
		}
		throw error;
	}
}

export async function installCatalogPlugin(entry: CatalogPlugin): Promise<void> {
	if (active.has(entry.id)) throw Error("Plugin installation already in progress");
	active.add(entry.id);
	try {
		if (coreIds.includes(entry.id)) throw Error("Core plugin IDs cannot be installed from the community catalog");
		const host = await getPluginHost();
		const installed = host.list().find(plugin => plugin.id === entry.id);
		if (installed?.enabled) throw Error("Disable this plugin before updating it, then restart LearnHarness afterward");
		if (installed?.manifest && comparePluginVersions(entry.version, installed.manifest.version) <= 0) throw Error("This version is already installed or older than the installed plugin");
		const bytes = await download(entry);
		safeDirectory(pluginDirectory);
		const plugin = path.join(pluginDirectory, entry.id);
		safeDirectory(plugin);
		const stage = fs.mkdtempSync(path.join(plugin, ".catalog-install-"));
		const next = path.join(stage, "dist");
		let keepBackup = false;
		try {
			fs.mkdirSync(next);
			await extractCatalogZip(bytes, next);
			const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(next, "manifest.json"), "utf8")), entry.id, packageJson.version);
			if (manifest.version !== entry.version || manifest.minAppVersion !== entry.minAppVersion || manifest.name !== entry.name) throw Error("Plugin manifest differs from catalog listing");
			for (const filename of [manifest.main, manifest.backend, manifest.styles].filter((value): value is string => !!value)) {
				if (!fs.lstatSync(path.join(next, filename), { throwIfNoEntry: false })?.isFile()) throw Error(`Missing plugin entry: ${filename}`);
			}
			await replacePluginDist(plugin, next, () => host.refresh());
		} catch (error) {
			if (fs.existsSync(path.join(stage, "previous"))) keepBackup = true;
			throw error;
		} finally { if (!keepBackup) fs.rmSync(stage, { recursive: true, force: true }); }
	} finally { active.delete(entry.id); }
}

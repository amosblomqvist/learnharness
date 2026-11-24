import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChatRecord, JobRecord } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
export interface ThreadBundle { version: 1; chat: ChatRecord; jobs: JobRecord[]; files: Record<string, string> }
const ID = /^[A-Za-z0-9_-]{1,200}$/;
export function validThreadId(id: string): boolean { return ID.test(id); }
export function bundleDigest(bundle: ThreadBundle): string { return createHash("sha256").update(JSON.stringify(bundle)).digest("hex"); }

function jsonFiles(directory: string): string[] {
	try { return fs.readdirSync(directory).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name)).sort(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function threadIds(root: string): string[] { return jsonFiles(path.join(root, "chats")).map(name => name.slice(0, -5)); }
function readJson(filename: string): unknown { return JSON.parse(fs.readFileSync(filename, "utf8")); }

function mapStrings(value: unknown, map: (value: string) => string): unknown {
	if (typeof value === "string") return map(value);
	if (Array.isArray(value)) return value.map(child => mapStrings(child, map));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapStrings(child, map)]));
	return value;
}
function managedFiles(root: string): string[] {
	const directory = path.join(root, "attachments");
	if (!fs.existsSync(directory)) return [];
	if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Managed attachments cannot be a symbolic link.");
	const files: string[] = [];
	for (const group of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!group.isDirectory() || !/^[0-9a-f-]{36}$/.test(group.name)) continue;
		for (const file of fs.readdirSync(path.join(directory, group.name), { withFileTypes: true })) {
			if (file.isFile() && safeAttachment(`${group.name}/${file.name}`)) files.push(`${group.name}/${file.name}`);
		}
	}
	return files.sort();
}
function safeAttachment(name: string): boolean {
	return /^[0-9a-f-]{36}\/[^\\/<>:"|?*\x00-\x1f\x7f]+$/.test(name) && !name.endsWith(".") && !name.endsWith(" ");
}
export function readThreadBundle(root: string, id: string): ThreadBundle | null {
	if (!validThreadId(id)) throw new Error("Invalid thread id.");
	const filename = path.join(root, "chats", `${id}.json`);
	if (!fs.existsSync(filename)) return null;
	const chat = readJson(filename) as ChatRecord;
	const jobs = jsonFiles(path.join(root, "jobs")).map(name => readJson(path.join(root, "jobs", name)) as JobRecord).filter(job => job.chatId === id);
	const bundle: ThreadBundle = { version: 1, chat, jobs, files: {} };
	const referenced = new Set<string>();
	const candidates = managedFiles(root);
	const portable = mapStrings(bundle, text => {
		for (const relative of candidates) {
			const filename = path.join(root, "attachments", ...relative.split("/"));
			if (text.includes(filename)) { referenced.add(relative); text = text.replaceAll(filename, `lh-attachment://${relative}`); }
		}
		return text;
	}) as ThreadBundle;
	let bytes = Buffer.byteLength(JSON.stringify(portable));
	for (const relative of [...referenced].sort()) {
		const file = path.join(root, "attachments", ...relative.split("/"));
		bytes += Math.ceil(fs.statSync(file).size / 3) * 4;
		if (bytes > MAX_BUNDLE_BYTES) throw new Error(`Thread “${chat.title}” exceeds the 128 MiB sync limit.`);
		portable.files[relative] = fs.readFileSync(file).toString("base64");
	}
	validateThreadBundle(portable, id);
	if (Buffer.byteLength(JSON.stringify(portable)) > MAX_BUNDLE_BYTES) throw new Error(`Thread “${chat.title}” exceeds the 128 MiB sync limit.`);
	return portable;
}
export function validateThreadBundle(raw: unknown, id: string): asserts raw is ThreadBundle {
	const bundle = raw as ThreadBundle | null;
	if (!bundle || bundle.version !== 1 || !bundle.chat || bundle.chat.id !== id || !validThreadId(id)
		|| typeof bundle.chat.title !== "string" || typeof bundle.chat.createdAt !== "string" || typeof bundle.chat.updatedAt !== "string"
		|| !Array.isArray(bundle.chat.messages) || (bundle.chat.version ?? 1) > CURRENT_CHAT_VERSION
		|| !Array.isArray(bundle.jobs) || !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) throw new Error("Unsupported cloud thread snapshot.");
	for (const job of bundle.jobs) {
		if (!job || !validThreadId(job.id) || job.chatId !== id || !["done", "error"].includes(job.status)) throw new Error("Thread has unfinished background work.");
	}
	for (const [name, data] of Object.entries(bundle.files)) {
		if (!safeAttachment(name) || typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Invalid cloud attachment.");
	}
}
/** Reject symlinked cache paths before writing untrusted snapshot filenames. */
function safeWrite(root: string, relative: string, bytes: string | Buffer): void {
	const filename = path.join(root, relative);
	let cursor = root;
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Account cache cannot be a symbolic link.");
	for (const segment of relative.split(path.sep).slice(0, -1)) {
		cursor = path.join(cursor, segment);
		if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Account cache cannot contain symbolic links.");
		fs.mkdirSync(cursor, { recursive: true, mode: 0o700 });
	}
	if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error("Account cache cannot contain symbolic links.");
	writeFileAtomicSync(filename, bytes, { mode: 0o600 });
}
export function writeThreadBundle(root: string, bundle: ThreadBundle): void {
	validateThreadBundle(bundle, bundle.chat.id);
	const local = mapStrings(bundle, text => {
		for (const relative of Object.keys(bundle.files)) text = text.replaceAll(`lh-attachment://${relative}`, path.join(root, "attachments", ...relative.split("/")));
		return text;
	}) as ThreadBundle;
	for (const [name, bytes] of Object.entries(bundle.files)) safeWrite(root, path.join("attachments", ...name.split("/")), Buffer.from(bytes, "base64"));
	for (const job of local.jobs) safeWrite(root, path.join("jobs", `${job.id}.json`), JSON.stringify(job));
	removeObsoleteJobs(root, local.chat.id, new Set(local.jobs.map(job => `${job.id}.json`)));
	// Thread is the commit marker: dependencies exist before it becomes visible.
	safeWrite(root, path.join("chats", `${local.chat.id}.json`), JSON.stringify(local.chat));
}
export function removeThreadBundle(root: string, id: string): void {
	if (!validThreadId(id)) throw new Error("Invalid thread id.");
	fs.rmSync(path.join(root, "chats", `${id}.json`), { force: true });
	removeObsoleteJobs(root, id, new Set());
}
function removeObsoleteJobs(root: string, id: string, keep: Set<string>): void {
	for (const name of jsonFiles(path.join(root, "jobs"))) {
		if (keep.has(name)) continue;
		const file = path.join(root, "jobs", name);
		if ((readJson(file) as JobRecord).chatId === id) fs.rmSync(file, { force: true });
	}
}

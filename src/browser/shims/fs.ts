/**
 * `node:fs` for the phone build (mobile Phase 0) — the subset the bundled
 * server code calls, implemented over the in-memory tree in ./vfs.ts.
 * Text is stored as strings; binary writes stay Uint8Array.
 */

import { Buffer } from "./buffer.ts";
import * as vfs from "./vfs.ts";

type EncodingArg = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null | undefined;
type BufferEncoding = "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1" | "binary";

function encodingOf(arg: EncodingArg): BufferEncoding | null {
	if (!arg) return null;
	if (typeof arg === "string") return arg;
	return arg.encoding ?? null;
}

function pathOf(p: unknown): string {
	if (typeof p === "string") return p;
	if (p instanceof URL) return decodeURIComponent(p.pathname);
	return String(p);
}

function decode(content: vfs.FileContent, encoding: BufferEncoding | null): string | Buffer {
	if (encoding) {
		if (typeof content === "string") {
			return encoding === "utf8" || encoding === "utf-8" ? content : Buffer.from(content).toString(encoding);
		}
		return Buffer.wrap(content).toString(encoding);
	}
	return typeof content === "string" ? Buffer.from(content) : Buffer.wrap(content);
}

function toContent(data: unknown): vfs.FileContent {
	if (typeof data === "string") return data;
	if (data instanceof Uint8Array) return new Uint8Array(data);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return String(data);
}

class Stats {
	constructor(private info: vfs.StatInfo) {}
	isFile() {
		return this.info.isFile;
	}
	isDirectory() {
		return this.info.isDirectory;
	}
	isSymbolicLink() {
		return false;
	}
	get size() {
		return this.info.size;
	}
	get mtimeMs() {
		return this.info.mtimeMs;
	}
	get mtime() {
		return new Date(this.info.mtimeMs);
	}
	get mode() {
		return this.info.isDirectory ? 0o40755 : 0o100600;
	}
}

export class Dirent {
	constructor(
		public name: string,
		private dir: boolean,
		public parentPath: string,
	) {}
	isFile() {
		return !this.dir;
	}
	isDirectory() {
		return this.dir;
	}
	isSymbolicLink() {
		return false;
	}
	get path() {
		return this.parentPath;
	}
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0 };

// ─── Sync API ──────────────────────────────────────────────────────────────

export function readFileSync(path: unknown, options?: EncodingArg): string | Buffer {
	return decode(vfs.readFile(pathOf(path)), encodingOf(options));
}

export function writeFileSync(path: unknown, data: unknown, _options?: unknown): void {
	vfs.writeFile(pathOf(path), toContent(data));
}

export function appendFileSync(path: unknown, data: unknown, _options?: unknown): void {
	const p = pathOf(path);
	let before: vfs.FileContent = "";
	try {
		before = vfs.readFile(p);
	} catch (err) {
		if ((err as vfs.FsError).code !== "ENOENT") throw err;
	}
	const next = toContent(data);
	if (typeof before === "string" && typeof next === "string") vfs.writeFile(p, before + next);
	else vfs.writeFile(p, Buffer.concat([toBytes(before), toBytes(next)]));
}

function toBytes(c: vfs.FileContent): Uint8Array {
	return typeof c === "string" ? new TextEncoder().encode(c) : c;
}

export function existsSync(path: unknown): boolean {
	try {
		vfs.stat(pathOf(path));
		return true;
	} catch {
		return false;
	}
}

export function statSync(path: unknown, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
	try {
		return new Stats(vfs.stat(pathOf(path)));
	} catch (err) {
		if (options?.throwIfNoEntry === false) return undefined;
		throw err;
	}
}

export const lstatSync = statSync;

export function mkdirSync(path: unknown, options?: { recursive?: boolean; mode?: number } | number): string | undefined {
	const recursive = typeof options === "object" && options?.recursive === true;
	return vfs.makeDir(pathOf(path), recursive);
}

export function readdirSync(path: unknown, options?: { withFileTypes?: boolean } | BufferEncoding): string[] | Dirent[] {
	const p = pathOf(path);
	const entries = vfs.list(p);
	if (typeof options === "object" && options?.withFileTypes) {
		return entries.map((e) => new Dirent(e.name, e.isDirectory, vfs.normalize(p)));
	}
	return entries.map((e) => e.name);
}

export function unlinkSync(path: unknown): void {
	vfs.removeFile(pathOf(path));
}

export function rmSync(path: unknown, options?: { recursive?: boolean; force?: boolean }): void {
	vfs.removeTree(pathOf(path), options);
}

export function renameSync(from: unknown, to: unknown): void {
	vfs.rename(pathOf(from), pathOf(to));
}

export function chmodSync(path: unknown, _mode: number): void {
	vfs.stat(pathOf(path));
}

export function accessSync(path: unknown, _mode?: number): void {
	vfs.stat(pathOf(path), "access");
}

let tempCounter = 0;
export function mkdtempSync(prefix: string): string {
	const dir = `${prefix}${Date.now().toString(36)}${(tempCounter++).toString(36)}`;
	vfs.makeDir(dir, true);
	return vfs.normalize(dir);
}

// ─── Promise API (node:fs/promises) ─────────────────────────────────────────

const wrap =
	<A extends unknown[], R>(fn: (...args: A) => R) =>
	async (...args: A): Promise<R> =>
		fn(...args);

export const promises = {
	readFile: wrap(readFileSync),
	writeFile: wrap(writeFileSync),
	appendFile: wrap(appendFileSync),
	stat: wrap((p: unknown) => statSync(p) as Stats),
	lstat: wrap((p: unknown) => statSync(p) as Stats),
	mkdir: wrap(mkdirSync),
	readdir: wrap(readdirSync),
	unlink: wrap(unlinkSync),
	rm: wrap(rmSync),
	rename: wrap(renameSync),
	access: wrap(accessSync),
	mkdtemp: wrap(mkdtempSync),
	chmod: wrap(chmodSync),
	async open(path: unknown, _flags?: string) {
		const bytes = toBytes(vfs.readFile(pathOf(path)));
		return {
			async read(buffer: Uint8Array, offset: number, length: number, position: number | null) {
				const start = position ?? 0;
				const chunk = bytes.subarray(start, start + length);
				buffer.set(chunk, offset);
				return { bytesRead: chunk.byteLength, buffer };
			},
			async close() {},
		};
	},
};

const fs = {
	readFileSync,
	writeFileSync,
	appendFileSync,
	existsSync,
	statSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	rmSync,
	renameSync,
	chmodSync,
	accessSync,
	mkdtempSync,
	constants,
	Dirent,
	promises,
};

export default fs;

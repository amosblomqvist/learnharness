/**
 * The phone build's synchronous file system (mobile Phase 0).
 *
 * The store adapters (src/store/*) are synchronous `node:fs` code. Rather
 * than fork them, the browser bundle aliases `node:fs` to this module: an
 * in-memory tree that is loaded from IndexedDB once at boot and written
 * back after every mutation. The on-device data therefore keeps the exact
 * desktop layout (data/chats/*.json, data/graph/*.jsonl, ...).
 *
 * Contract: reads and writes are synchronous against memory; persistence
 * is asynchronous write-behind. `flush()` resolves once every mutation made
 * so far has reached IndexedDB.
 */

export type FileContent = string | Uint8Array;

type Entry = { content: FileContent; mtimeMs: number };

const files = new Map<string, Entry>();
const dirs = new Set<string>(["/"]);

// ─── Persistence hook (installed by src/browser/persist.ts) ─────────────────

export type PersistSink = {
	put(path: string, content: FileContent, mtimeMs: number): void;
	remove(path: string): void;
};

let sink: PersistSink | null = null;

export function setPersistSink(next: PersistSink | null): void {
	sink = next;
}

/** Boot-time load: seed one file without triggering persistence. */
export function seedFile(path: string, content: FileContent, mtimeMs = Date.now()): void {
	const p = normalize(path);
	ensureParents(p);
	files.set(p, { content, mtimeMs });
}

/** Every file path currently in memory (backup/export uses this later). */
export function allFiles(): string[] {
	return [...files.keys()].sort();
}

// ─── Path helpers (POSIX only; the browser bundle has one root) ────────────

export function normalize(input: string): string {
	const parts: string[] = [];
	for (const seg of String(input).split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return "/" + parts.join("/");
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i <= 0 ? "/" : p.slice(0, i);
}

function ensureParents(p: string): void {
	let dir = parentOf(p);
	const chain: string[] = [];
	while (!dirs.has(dir)) {
		chain.push(dir);
		dir = parentOf(dir);
	}
	for (const d of chain) dirs.add(d);
}

export class FsError extends Error {
	constructor(
		public code: string,
		syscall: string,
		public path: string,
	) {
		super(`${code}: ${syscall} '${path}'`);
	}
	get errno(): number {
		return -1;
	}
	get syscall(): string {
		return this.message.split(":")[1]?.trim().split(" ")[0] ?? "";
	}
}

// ─── Primitive operations ───────────────────────────────────────────────────

export function readFile(path: string, syscall = "open"): FileContent {
	const p = normalize(path);
	const entry = files.get(p);
	if (!entry) {
		if (dirs.has(p)) throw new FsError("EISDIR", "read", p);
		throw new FsError("ENOENT", syscall, p);
	}
	return entry.content;
}

export function writeFile(path: string, content: FileContent): void {
	const p = normalize(path);
	if (dirs.has(p)) throw new FsError("EISDIR", "open", p);
	if (!dirs.has(parentOf(p))) throw new FsError("ENOENT", "open", p);
	const mtimeMs = Date.now();
	files.set(p, { content, mtimeMs });
	sink?.put(p, content, mtimeMs);
}

export function removeFile(path: string): void {
	const p = normalize(path);
	if (!files.has(p)) {
		if (dirs.has(p)) throw new FsError("EISDIR", "unlink", p);
		throw new FsError("ENOENT", "unlink", p);
	}
	files.delete(p);
	sink?.remove(p);
}

export function makeDir(path: string, recursive: boolean): string | undefined {
	const p = normalize(path);
	if (dirs.has(p)) {
		if (recursive) return undefined;
		throw new FsError("EEXIST", "mkdir", p);
	}
	if (files.has(p)) throw new FsError("EEXIST", "mkdir", p);
	if (!recursive && !dirs.has(parentOf(p))) throw new FsError("ENOENT", "mkdir", p);
	ensureParents(p);
	dirs.add(p);
	return p;
}

export function removeTree(path: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
	const p = normalize(path);
	if (files.has(p)) return removeFile(p);
	if (!dirs.has(p)) {
		if (opts.force) return;
		throw new FsError("ENOENT", "rm", p);
	}
	const prefix = p === "/" ? "/" : p + "/";
	const children = [...files.keys()].filter((f) => f.startsWith(prefix));
	const subdirs = [...dirs].filter((d) => d.startsWith(prefix));
	if (!opts.recursive && (children.length || subdirs.length)) throw new FsError("ENOTEMPTY", "rm", p);
	for (const f of children) removeFile(f);
	for (const d of subdirs) dirs.delete(d);
	if (p !== "/") dirs.delete(p);
}

export function rename(from: string, to: string): void {
	const a = normalize(from);
	const b = normalize(to);
	const entry = files.get(a);
	if (!entry) throw new FsError("ENOENT", "rename", a);
	if (!dirs.has(parentOf(b))) throw new FsError("ENOENT", "rename", b);
	files.delete(a);
	sink?.remove(a);
	const mtimeMs = Date.now();
	files.set(b, { content: entry.content, mtimeMs });
	sink?.put(b, entry.content, mtimeMs);
}

export type StatInfo = { isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number };

export function stat(path: string, syscall = "stat"): StatInfo {
	const p = normalize(path);
	const entry = files.get(p);
	if (entry) {
		const size = typeof entry.content === "string" ? new TextEncoder().encode(entry.content).byteLength : entry.content.byteLength;
		return { isFile: true, isDirectory: false, size, mtimeMs: entry.mtimeMs };
	}
	if (dirs.has(p)) return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
	throw new FsError("ENOENT", syscall, p);
}

export function list(path: string): { name: string; isDirectory: boolean }[] {
	const p = normalize(path);
	if (!dirs.has(p)) {
		if (files.has(p)) throw new FsError("ENOTDIR", "scandir", p);
		throw new FsError("ENOENT", "scandir", p);
	}
	const prefix = p === "/" ? "/" : p + "/";
	const out = new Map<string, boolean>();
	for (const f of files.keys()) {
		if (!f.startsWith(prefix)) continue;
		const rest = f.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash === -1) out.set(rest, false);
		else out.set(rest.slice(0, slash), true);
	}
	for (const d of dirs) {
		if (!d.startsWith(prefix) || d === p) continue;
		const rest = d.slice(prefix.length);
		out.set(rest.split("/")[0]!, true);
	}
	return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([name, isDirectory]) => ({ name, isDirectory }));
}

/** Test seam: wipe the in-memory tree (never touches IndexedDB). */
export function resetForTests(): void {
	files.clear();
	dirs.clear();
	dirs.add("/");
}

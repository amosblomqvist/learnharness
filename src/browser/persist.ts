/**
 * IndexedDB persistence for the phone build's file system (mobile Phase 0).
 *
 * One object store, key = absolute virtual path, value = {content, mtimeMs}.
 * Boot loads every record into ./shims/vfs.ts; afterwards every mutation is
 * queued and written in the next batch (one transaction per batch, latest
 * write per path wins). Nothing here knows what the files mean.
 */

import { allFiles, normalize, seedFile, setPersistSink, type FileContent } from "./shims/vfs.ts";

const DB_NAME = "learnharness";
const DB_VERSION = 1;
const STORE = "files";

type Row = { content: FileContent; mtimeMs: number };
type Op = { kind: "put"; row: Row } | { kind: "remove" };

function promisify<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function openDb(): Promise<IDBDatabase> {
	const req = indexedDB.open(DB_NAME, DB_VERSION);
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
	};
	return promisify(req);
}

let db: IDBDatabase | null = null;
const pending = new Map<string, Op>();
/** The batch chain: each batch starts after the previous one commits. */
let chain: Promise<void> = Promise.resolve();
let queued = false;
let lastError: unknown = null;

function writeBatch(): Promise<void> {
	queued = false;
	const batch = [...pending];
	pending.clear();
	if (!db || batch.length === 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const tx = db!.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		for (const [path, op] of batch) {
			if (op.kind === "put") store.put(op.row, path);
			else store.delete(path);
		}
		tx.oncomplete = () => resolve();
		tx.onerror = tx.onabort = () => {
			lastError = tx.error;
			console.error("[persist] IndexedDB write failed:", tx.error);
			resolve();
		};
	});
}

function enqueue(path: string, op: Op): void {
	pending.set(path, op);
	if (queued) return;
	queued = true;
	chain = chain.then(writeBatch);
}

/** Load every stored file into memory, then start write-behind persistence.
 *  `assets` are read-only app files (prompts) seeded from the bundle; they
 *  are never written to IndexedDB. */
export async function bootPersistence(assets: Record<string, string>): Promise<{ files: number }> {
	for (const [path, text] of Object.entries(assets)) seedFile(path, text, 0);
	db = await openDb();
	const tx = db.transaction(STORE, "readonly");
	const store = tx.objectStore(STORE);
	const [keys, rows] = await Promise.all([promisify(store.getAllKeys()), promisify(store.getAll() as IDBRequest<Row[]>)]);
	keys.forEach((key, i) => seedFile(String(key), rows[i]!.content, rows[i]!.mtimeMs));
	setPersistSink({
		put: (path, content, mtimeMs) => {
			if (!isAsset(path, assets)) enqueue(path, { kind: "put", row: { content, mtimeMs } });
		},
		remove: (path) => enqueue(path, { kind: "remove" }),
	});
	// Ask the browser not to evict this origin's storage under pressure.
	// Best effort: unsupported or refused simply leaves default behavior.
	await navigator.storage?.persist?.().catch(() => false);
	return { files: keys.length };
}

function isAsset(path: string, assets: Record<string, string>): boolean {
	return Object.prototype.hasOwnProperty.call(assets, normalize(path));
}

/** Resolves once every mutation made so far is committed to IndexedDB. */
export async function flushPersistence(): Promise<void> {
	let seen: Promise<void>;
	do {
		seen = chain;
		await seen;
	} while (seen !== chain);
	if (lastError) {
		const err = lastError;
		lastError = null;
		throw err;
	}
}

export { allFiles };

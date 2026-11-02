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
/** Transactions started and not yet settled. Each batch gets its own
 *  transaction AT ONCE (no waiting on the previous one): IndexedDB runs
 *  readwrite transactions on one store in creation order, so order holds,
 *  and the window in which closing the app could lose a write is a single
 *  microtask instead of "until every earlier batch committed". */
const inflight = new Set<Promise<void>>();
let scheduled = false;
let lastError: unknown = null;

function writeBatch(): void {
	scheduled = false;
	const batch = [...pending];
	pending.clear();
	if (!db || batch.length === 0) return;
	const done = new Promise<void>((resolve) => {
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
		// Commit now rather than when the event loop idles (Safari 15+).
		(tx as IDBTransaction & { commit?: () => void }).commit?.();
	});
	inflight.add(done);
	void done.then(() => inflight.delete(done));
}

function enqueue(path: string, op: Op): void {
	pending.set(path, op);
	if (scheduled) return;
	scheduled = true;
	// One microtask: writes made in the same synchronous run share a batch.
	queueMicrotask(writeBatch);
}

/** The app is being hidden or closed (iOS may then suspend or kill it):
 *  hand anything still batching to IndexedDB right now. */
function writeNow(): void {
	if (pending.size > 0) writeBatch();
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
	addEventListener("pagehide", writeNow);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") writeNow();
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
	while (scheduled || pending.size > 0 || inflight.size > 0) {
		writeNow();
		await Promise.all([...inflight]);
	}
	if (lastError) {
		const err = lastError;
		lastError = null;
		throw err;
	}
}

export { allFiles };

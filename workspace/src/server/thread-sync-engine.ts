import { reconcileThread, type SyncHead } from "../core/thread-sync.ts";
import { bundleDigest, type ThreadBundle } from "../store/thread-bundles.ts";

export interface SyncRemote {
	list(): Promise<Record<string, SyncHead>>;
	read(id: string, revision: string): Promise<ThreadBundle | null>;
	write(id: string, expected: string | null, bundle: ThreadBundle | null, updatedAt: number): Promise<SyncHead | null>;
}
export interface SyncLocal {
	ids(): string[];
	read(id: string): ThreadBundle | null;
	busy(id: string): boolean;
	modifiedAt(id: string): number;
	write(id: string, bundle: ThreadBundle | null, updatedAt: number): void;
	loadIndex(): Record<string, SyncHead>;
	saveIndex(index: Record<string, SyncHead>): void;
}
/** Network work never holds a stale local read across a destructive write. */
export async function syncThreads(local: SyncLocal, remote: SyncRemote): Promise<{ deferred: number }> {
	const index = local.loadIndex();
	const heads = await remote.list();
	let deferred = 0;
	for (const id of new Set([...local.ids(), ...Object.keys(index), ...Object.keys(heads)])) {
		if (local.busy(id)) { deferred++; continue; }
		const bundle = local.read(id);
		const digest = bundle ? bundleDigest(bundle) : null;
		const head = heads[id];
		const modifiedAt = local.modifiedAt(id);
		const decision = reconcileThread(digest, index[id], head, modifiedAt);
		const unchanged = () => {
			if (local.busy(id) || local.modifiedAt(id) !== modifiedAt) return false;
			const current = local.read(id);
			return (current ? bundleDigest(current) : null) === digest;
		};
		if (decision === "equal") {
			if (head) { index[id] = head; local.saveIndex(index); }
			continue;
		}
		if (decision === "push") {
			const committed = await remote.write(id, head?.revision ?? null, bundle, modifiedAt);
			if (committed) { index[id] = committed; local.saveIndex(index); }
			else deferred++;
			continue;
		}
		const downloaded = head?.digest ? await remote.read(id, head.revision) : null;
		if (head?.digest && !downloaded) { deferred++; continue; }
		if (downloaded && bundleDigest(downloaded) !== head?.digest) throw new Error("Cloud snapshot failed its integrity check.");
		if (!unchanged()) { deferred++; continue; }
		local.write(id, downloaded, head?.updatedAt ?? 0);
		if (head) index[id] = head;
		else delete index[id];
		local.saveIndex(index);
	}
	return { deferred };
}

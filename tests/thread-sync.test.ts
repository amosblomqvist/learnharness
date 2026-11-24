import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileThread, type SyncHead } from "../src/core/thread-sync.ts";
import { syncThreads, type SyncLocal, type SyncRemote } from "../src/server/thread-sync-engine.ts";
import { bundleDigest, type ThreadBundle } from "../src/store/thread-bundles.ts";

const id = "chat_sync";
function bundle(title: string): ThreadBundle {
	return { version: 1, chat: { id, title, createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [], version: 2 }, jobs: [], files: {} };
}
class Computer implements SyncLocal {
	data = new Map<string, ThreadBundle>(); times = new Map<string, number>(); index: Record<string, SyncHead> = {};
	working = false;
	ids() { return [...this.data.keys()]; }
	read(id: string) { return structuredClone(this.data.get(id) ?? null); }
	busy() { return this.working; }
	modifiedAt(id: string) { return this.times.get(id) ?? 0; }
	write(id: string, value: ThreadBundle | null, time: number) { if (value) this.data.set(id, structuredClone(value)); else this.data.delete(id); this.times.set(id, time); }
	loadIndex() { return structuredClone(this.index); }
	saveIndex(index: Record<string, SyncHead>) { this.index = structuredClone(index); }
	edit(title: string, time: number) { this.write(id, bundle(title), time); }
}
class Cloud implements SyncRemote {
	heads: Record<string, SyncHead> = {}; data = new Map<string, ThreadBundle>(); next = 0;
	beforeRead?: () => void; beforeWrite?: () => void;
	async list() { return structuredClone(this.heads); }
	async read(id: string, revision: string) { this.beforeRead?.(); return this.heads[id]?.revision === revision ? structuredClone(this.data.get(id) ?? null) : null; }
	async write(id: string, expected: string | null, value: ThreadBundle | null, updatedAt: number) {
		this.beforeWrite?.();
		if ((this.heads[id]?.revision ?? null) !== expected) return null;
		const head = { revision: String(++this.next), digest: value ? bundleDigest(value) : null, updatedAt };
		this.heads[id] = head;
		if (value) this.data.set(id, structuredClone(value)); else this.data.delete(id);
		return head;
	}
}
describe("optional cross-computer thread sync", () => {
	it("uploads local threads and restores complete saved state on another computer", async () => {
		const cloud = new Cloud(), a = new Computer(), b = new Computer();
		a.edit("Original", 100);
		const full = a.data.get(id)!;
		full.chat.sideChats = []; full.chat.imageSnapshots = { image: { mimeType: "image/png", data: "AA==", width: 1, height: 1 } };
		await syncThreads(a, cloud); await syncThreads(b, cloud);
		assert.deepEqual(b.read(id), a.read(id));
		assert.equal(b.modifiedAt(id), 100);
		assert.deepEqual(b.index, a.index);
	});
	it("keeps offline changes queued, then uploads them after reconnection", async () => {
		const cloud = new Cloud(), a = new Computer(); a.edit("Offline", 100);
		await assert.rejects(syncThreads(a, { ...cloud, list: async () => { throw new Error("offline"); }, read: cloud.read.bind(cloud), write: cloud.write.bind(cloud) }));
		assert.equal(a.read(id)?.chat.title, "Offline"); assert.deepEqual(a.index, {});
		await syncThreads(a, cloud); assert.equal(cloud.data.get(id)?.chat.title, "Offline");
	});
	it("uses the newest offline edit regardless of which computer reconnects first", async () => {
		for (const newerFirst of [false, true]) {
			const cloud = new Cloud(), a = new Computer(), b = new Computer();
			a.edit("Original", 100); await syncThreads(a, cloud); await syncThreads(b, cloud);
			a.edit("Older edit", 200); b.edit("Newest edit", 300);
			await syncThreads(newerFirst ? b : a, cloud); await syncThreads(newerFirst ? a : b, cloud);
			await syncThreads(a, cloud); await syncThreads(b, cloud);
			assert.equal(a.read(id)?.chat.title, "Newest edit"); assert.equal(b.read(id)?.chat.title, "Newest edit");
			assert.deepEqual(Object.keys(cloud.heads), [id]);
		}
	});
	it("syncs renames even when the existing activity timestamp did not change", async () => {
		const cloud = new Cloud(), a = new Computer(), b = new Computer();
		a.edit("Original", 100); await syncThreads(a, cloud); await syncThreads(b, cloud);
		a.edit("Renamed", 200); await syncThreads(a, cloud); await syncThreads(b, cloud);
		assert.equal(b.read(id)?.chat.title, "Renamed");
	});
	it("propagates deletion and prevents an older offline edit from resurrecting it", async () => {
		const cloud = new Cloud(), a = new Computer(), b = new Computer();
		a.edit("Original", 100); await syncThreads(a, cloud); await syncThreads(b, cloud);
		b.edit("Older offline edit", 200); a.write(id, null, 300);
		await syncThreads(a, cloud); await syncThreads(b, cloud);
		assert.equal(b.read(id), null); assert.equal(cloud.heads[id]?.digest, null);
	});
	it("preserves an update made after a conflicting deletion", async () => {
		const cloud = new Cloud(), a = new Computer(), b = new Computer();
		a.edit("Original", 100); await syncThreads(a, cloud); await syncThreads(b, cloud);
		a.write(id, null, 200); b.edit("Newer edit", 300);
		await syncThreads(a, cloud); await syncThreads(b, cloud); await syncThreads(a, cloud);
		assert.equal(a.read(id)?.chat.title, "Newer edit");
	});
	it("does not replace an edit or active turn that starts while a download is in flight", async () => {
		for (const startTurn of [false, true]) {
			const cloud = new Cloud(), a = new Computer(), b = new Computer();
			a.edit("Original", 100); await syncThreads(a, cloud); await syncThreads(b, cloud);
			a.edit("Remote edit", 200); await syncThreads(a, cloud);
			cloud.beforeRead = () => { if (startTurn) b.working = true; else b.edit("In-flight local edit", 300); };
			assert.equal((await syncThreads(b, cloud)).deferred, 1);
			assert.equal(b.read(id)?.chat.title, startTurn ? "Original" : "In-flight local edit");
		}
	});
	it("retries a compare-and-swap race without overwriting a newer cloud revision", async () => {
		const cloud = new Cloud(), a = new Computer(); a.edit("First", 100); await syncThreads(a, cloud);
		a.edit("Queued", 200);
		cloud.beforeWrite = () => { cloud.heads[id] = { revision: "race", digest: "different", updatedAt: 300 }; };
		assert.equal((await syncThreads(a, cloud)).deferred, 1);
		assert.equal(cloud.heads[id]?.revision, "race"); assert.equal(a.read(id)?.chat.title, "Queued");
	});
	it("rejects a corrupted snapshot before changing local data", async () => {
		const cloud = new Cloud(), a = new Computer();
		await cloud.write(id, null, bundle("Original"), 100); cloud.heads[id]!.digest = "tampered";
		await assert.rejects(syncThreads(a, cloud), /integrity/); assert.equal(a.read(id), null);
	});
	it("uses the committed cloud version when conflicting update times tie", () => {
		assert.equal(reconcileThread("local", { revision: "1", digest: "base", updatedAt: 100 }, { revision: "2", digest: "remote", updatedAt: 200 }, 200), "pull");
	});
});

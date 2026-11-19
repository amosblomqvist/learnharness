/**
 * THE SIDEBAR REFRESH SEQUENCER (chat-folders S02, 2026-11-19): one mounted
 * panel reads GET /api/chats as a single snapshot — chats AND the shared
 * source organization. createSidebarRefresh owns the read sequence: a
 * signal during a read queues exactly ONE repeat, invalidate() (a local
 * rename / delete / turn patch) marks the in-flight answer stale so it can
 * never overwrite the local edit, and a failed read (null) repeats only
 * when signaled. Driven with hand-resolved promises — no React, no fetch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSidebarRefresh } from "../components/sidebar-refresh.ts";
import type { ChatListItem, ChatListResponse } from "../src/core/index.ts";

function chat(id: string): ChatListItem {
	return {
		id,
		title: id,
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 1,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
	};
}

function snapshot(chats: ChatListItem[], placements: Record<string, { folderId: string }> = {}): ChatListResponse {
	return { chats, organization: { folders: [], placements } };
}

/** Let the sequencer's promise continuations run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One read in flight at a time — answer() resolves it, readCount() counts
 *  every read started, accepted[] records each acceptResult argument. */
function harness() {
	let reads = 0;
	let resolveRead: ((r: ChatListResponse | null) => void) | null = null;
	const accepted: Array<ChatListResponse | null> = [];
	const refresh = createSidebarRefresh(
		() =>
			new Promise<ChatListResponse | null>((resolve) => {
				reads++;
				resolveRead = resolve;
			}),
		(r) => accepted.push(r),
	);
	return {
		accepted,
		refresh,
		readCount: () => reads,
		answer(r: ChatListResponse | null) {
			assert.ok(resolveRead, "a read is in flight");
			resolveRead(r);
			resolveRead = null;
		},
	};
}

describe("createSidebarRefresh (the sidebar snapshot sequencer)", () => {
	it("a signal during the first read queues exactly one repeat whose snapshot is accepted", async () => {
		const h = harness();
		const series = h.refresh.request();
		assert.equal(h.readCount(), 1);
		void h.refresh.request();
		void h.refresh.request(); // the burst collapses into the same single repeat
		const first = snapshot([chat("c1")]);
		h.answer(first);
		await flush();
		assert.equal(h.readCount(), 2, "one repeat, not one per signal");
		const placed = snapshot([chat("c1")], { c1: { folderId: "folder_a" } });
		h.answer(placed);
		await series;
		assert.deepEqual(h.accepted, [first, placed]);
		assert.equal(h.accepted[1]?.organization?.placements["c1"]?.folderId, "folder_a");
	});

	it("several signals collapse into one repeat; a signal during the repeat queues one more read", async () => {
		const h = harness();
		const series = h.refresh.request();
		void h.refresh.request();
		void h.refresh.request();
		void h.refresh.request();
		const a = snapshot([chat("a")]);
		h.answer(a);
		await flush();
		assert.equal(h.readCount(), 2);
		void h.refresh.request(); // a signal while the repeat is in flight
		const b = snapshot([chat("b")]);
		h.answer(b);
		await flush();
		assert.equal(h.readCount(), 3, "the repeat's own signal earns one more sequential read");
		const c = snapshot([chat("c")]);
		h.answer(c);
		await series;
		assert.deepEqual(h.accepted, [a, b, c]);
	});

	it("a failed read repeats only when signaled; the next explicit request still works", async () => {
		const h = harness();
		const s1 = h.refresh.request();
		h.answer(null); // a whole-request failure reaches acceptResult as null
		await s1;
		assert.deepEqual(h.accepted, [null]);
		assert.equal(h.readCount(), 1, "an error alone never repeats");

		const s2 = h.refresh.request();
		void h.refresh.request(); // a signal lands while the retry is in flight
		h.answer(null);
		await flush();
		assert.equal(h.readCount(), 3, "the signaled failure does run the queued repeat");
		const recovered = snapshot([chat("c1")]);
		h.answer(recovered);
		await s2;
		assert.deepEqual(h.accepted, [null, null, recovered]);

		const s3 = h.refresh.request();
		const again = snapshot([chat("c2")]);
		h.answer(again);
		await s3;
		assert.deepEqual(h.accepted, [null, null, recovered, again]);
	});

	it("invalidate() drops the in-flight answer; the repeat's failure is reported once", async () => {
		const h = harness();
		const series = h.refresh.request();
		h.refresh.invalidate(); // a local edit lands mid-GET
		void h.refresh.request(); // collapses into the same single repeat
		h.answer(snapshot([chat("old")]));
		await flush();
		assert.equal(h.accepted.length, 0, "the stale snapshot never reaches the panel");
		assert.equal(h.readCount(), 2);
		h.answer(null); // the repeat fails (HTTP 500 → null)
		await series;
		assert.deepEqual(h.accepted, [null], "the failure is reported; the panel keeps its local edits");
	});

	it("invalidate() with nothing in flight starts nothing", () => {
		const h = harness();
		h.refresh.invalidate();
		assert.equal(h.readCount(), 0);
	});

	it("a valid snapshot with organization: null is accepted whole — distinct from a failed read", async () => {
		const h = harness();
		const series = h.refresh.request();
		const orgDown: ChatListResponse = { chats: [chat("c9")], organization: null };
		h.answer(orgDown);
		await series;
		assert.deepEqual(h.accepted, [orgDown]);
	});
});

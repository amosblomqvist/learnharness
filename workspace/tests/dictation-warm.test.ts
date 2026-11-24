/**
 * Unit tests — the dictation warm-token cache (mitigation D, owner
 * 2026-09-27: components/dictation.tsx createWarmMinter).
 *
 * The click path takes the cached promise instead of a remote mint, so
 * the cache's behavior IS the felt start latency: one mint per warm
 * window, honest re-mint on failure, TTL so a stale token is never
 * served, and refresh() warming the next run in the background.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWarmMinter } from "../components/dictation.tsx";

describe("warm-token cache (mitigation D, owner 2026-09-27)", () => {
	it("caches: concurrent and repeat mints share ONE promise and mint once", async () => {
		let mints = 0;
		const m = createWarmMinter(
			async () => {
				mints++;
				return "t1";
			},
			() => 1000,
			60_000,
		);
		const a = m.mint();
		const b = m.mint(); // concurrent — must NOT mint again
		assert.equal(a, b); // same promise instance
		assert.equal(await a, "t1");
		assert.equal(await m.mint(), "t1"); // repeat — still no second mint
		assert.equal(mints, 1);
	});

	it("a failed mint resets the cache — the next call re-mints (honest error path)", async () => {
		let keyless = true;
		let mints = 0;
		const m = createWarmMinter(
			async () => {
				mints++;
				if (keyless) throw new Error("Dictation needs a Deepgram key");
				return "t2";
			},
			() => 1000,
			60_000,
		);
		await assert.rejects(m.mint(), /Deepgram key/);
		keyless = false; // the key arrives
		assert.equal(await m.mint(), "t2");
		assert.equal(mints, 2);
	});

	it("TTL expiry re-mints — a stale token is never served", async () => {
		let t = 0;
		let mints = 0;
		const m = createWarmMinter(
			async () => {
				mints++;
				return `t${mints}`;
			},
			() => t,
			1000,
		);
		assert.equal(await m.mint(), "t1");
		t = 1500; // past the TTL
		assert.equal(await m.mint(), "t2");
		assert.equal(mints, 2);
		t = 1600; // still within t2's window
		assert.equal(await m.mint(), "t2");
		assert.equal(mints, 2);
	});

	it("refresh() re-mints in the background and caches the result for the next run", async () => {
		let mints = 0;
		const m = createWarmMinter(
			async () => {
				mints++;
				return `t${mints}`;
			},
			() => 1000,
			60_000,
		);
		assert.equal(await m.mint(), "t1");
		m.refresh(); // the run-end background warm
		assert.equal(mints, 2);
		assert.equal(await m.mint(), "t2"); // served from the refresh cache
		assert.equal(mints, 2); // no third mint
	});

	it("refresh() swallows failure — a keyless page just doesn't warm", async () => {
		let mints = 0;
		const m = createWarmMinter(
			async () => {
				mints++;
				throw new Error("Dictation needs a Deepgram key");
			},
			() => 1000,
			60_000,
		);
		m.refresh(); // must not reject (unhandled rejection would be a bug)
		await new Promise((r) => setTimeout(r, 0)); // let the background mint settle
		assert.equal(mints, 1);
	});
});

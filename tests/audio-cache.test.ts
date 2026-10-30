/**
 * The in-memory audio cache (components/audio-cache.ts, ElevenLabs voice
 * slice 8): wraps a (text, signal, options) → Blob loader. Keyed by chunk
 * text, voice and model; capped by total Blob size, oldest evicted first;
 * only successful loads are kept. The only fake is the wrapped loader.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withAudioCache, type ChunkLoader } from "../components/audio-cache.ts";

const blobOf = (size: number) => new Blob([new Uint8Array(size)]);

/** A loader that records its calls and answers every one with `size` bytes. */
function countingLoader(size = 10) {
	const calls: { text: string; voiceId?: string; modelId?: string }[] = [];
	const loader: ChunkLoader = async (text, _signal, options) => {
		calls.push({ text, ...options });
		return blobOf(size);
	};
	return { loader, calls };
}

const signal = () => new AbortController().signal;

describe("audio cache", () => {
	it("serves a repeated chunk without calling the loader again", async () => {
		const { loader, calls } = countingLoader();
		const load = withAudioCache(loader);
		const first = await load("Hello.", signal());
		const second = await load("Hello.", signal());
		assert.equal(calls.length, 1);
		assert.equal(second, first);
	});

	it("keys on voice and model: a different one loads again, the same one hits", async () => {
		const { loader, calls } = countingLoader();
		const load = withAudioCache(loader);
		await load("Hi.", signal());
		await load("Hi.", signal(), { voiceId: "v1" });
		await load("Hi.", signal(), { voiceId: "v1", modelId: "m1" });
		await load("Hi.", signal(), { voiceId: "v2", modelId: "m1" });
		assert.equal(calls.length, 4);
		await load("Hi.", signal());
		await load("Hi.", signal(), { voiceId: "v1", modelId: "m1" });
		assert.equal(calls.length, 4);
	});

	it("passes voice and model through to the loader", async () => {
		const { loader, calls } = countingLoader();
		await withAudioCache(loader)("Hi.", signal(), { voiceId: "v1", modelId: "m1" });
		assert.deepEqual(calls, [{ text: "Hi.", voiceId: "v1", modelId: "m1" }]);
	});

	it("evicts the oldest entries first to stay under the cap", async () => {
		const { loader, calls } = countingLoader(10);
		const load = withAudioCache(loader, { maxBytes: 25 });
		await load("a", signal());
		await load("b", signal());
		await load("c", signal()); // 30 bytes > 25: "a" goes
		assert.equal(calls.length, 3);
		await load("b", signal());
		await load("c", signal());
		assert.equal(calls.length, 3, "b and c survive");
		await load("a", signal());
		assert.equal(calls.length, 4, "a was evicted");
	});

	it("never caches a blob bigger than the cap, and keeps what was there", async () => {
		const sizes: Record<string, number> = { small: 10, huge: 100 };
		const calls: string[] = [];
		const load = withAudioCache(
			async (text) => {
				calls.push(text);
				return blobOf(sizes[text]!);
			},
			{ maxBytes: 50 },
		);
		await load("small", signal());
		await load("huge", signal());
		await load("huge", signal());
		await load("small", signal());
		assert.deepEqual(calls, ["small", "huge", "huge"]);
	});

	it("does not cache a failed load", async () => {
		let n = 0;
		const load = withAudioCache(async () => {
			if (++n === 1) throw new Error("boom");
			return blobOf(5);
		});
		await assert.rejects(load("x", signal()), /boom/);
		await load("x", signal());
		await load("x", signal());
		assert.equal(n, 2);
	});

	it("does not cache an aborted load", async () => {
		let n = 0;
		const load = withAudioCache((_text, sig) => {
			n++;
			return new Promise<Blob>((resolve, reject) => {
				sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				if (n > 1) resolve(blobOf(5));
			});
		});
		const controller = new AbortController();
		const first = load("x", controller.signal);
		controller.abort();
		await assert.rejects(first, { name: "AbortError" });
		await load("x", signal());
		await load("x", signal());
		assert.equal(n, 2);
	});

	it("shares one request between concurrent loads of the same key", async () => {
		let n = 0;
		let finish!: (blob: Blob) => void;
		const load = withAudioCache(() => {
			n++;
			return new Promise<Blob>((resolve) => (finish = resolve));
		});
		const a = load("x", signal());
		const b = load("x", signal());
		finish(blobOf(3));
		assert.equal(await a, await b);
		assert.equal(n, 1);
	});

	it("keeps a shared request alive when only one of its callers aborts", async () => {
		let upstream: AbortSignal | undefined;
		let finish!: (blob: Blob) => void;
		const load = withAudioCache((_text, sig) => {
			upstream = sig;
			return new Promise<Blob>((resolve) => (finish = resolve));
		});
		const first = new AbortController();
		const a = load("x", first.signal);
		const b = load("x", signal());
		first.abort();
		await assert.rejects(a, { name: "AbortError" });
		assert.equal(upstream!.aborted, false);
		finish(blobOf(3));
		assert.equal((await b).size, 3);
	});

	it("aborts the shared request once every caller has aborted", async () => {
		let upstream: AbortSignal | undefined;
		const load = withAudioCache((_text, sig) => {
			upstream = sig;
			return new Promise<Blob>((_resolve, reject) =>
				sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
			);
		});
		const c1 = new AbortController();
		const c2 = new AbortController();
		const a = load("x", c1.signal);
		const b = load("x", c2.signal);
		c1.abort();
		c2.abort();
		await assert.rejects(a, { name: "AbortError" });
		await assert.rejects(b, { name: "AbortError" });
		assert.equal(upstream!.aborted, true);
	});
});

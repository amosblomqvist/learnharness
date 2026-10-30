/**
 * The read-aloud player core (components/read-aloud-player.ts, ElevenLabs
 * voice slice 6): one audio element per window, one source at a time, chunks
 * played in order with chunk n+1 requested while chunk n plays, blob URLs
 * revoked, and an error state that tells keyless from upstream. Fakes sit at
 * the boundary only: fetch, the audio element, and the object-URL pair.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createReadAloudPlayer,
	READ_ALOUD_KEYLESS,
	type AudioLike,
	type ReadAloudSnapshot,
} from "../components/read-aloud-player.ts";

class FakeAudio implements AudioLike {
	src = "";
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	/** Every src that was started with play(), in order. */
	played: string[] = [];
	paused = 0;
	playRejects = false;
	async play() {
		if (this.playRejects) throw new Error("NotAllowedError");
		this.played.push(this.src);
	}
	pause() {
		this.paused++;
	}
	/** The current chunk finished playing. */
	end() {
		this.onended?.();
	}
	fail() {
		this.onerror?.();
	}
}

interface Pending {
	text: string;
	voiceId?: string;
	modelId?: string;
	signal: AbortSignal | null | undefined;
	respond: (res: Response) => void;
	reject: (error: unknown) => void;
}

/** A fake /api/tts: every request waits until the test answers it. */
function harness(speech?: () => { voiceId?: string; modelId?: string }) {
	const audios: FakeAudio[] = [];
	const requests: Pending[] = [];
	let urlCount = 0;
	const blobs = new Map<string, Blob>();
	const revoked: string[] = [];
	const fetchFake = ((url: string, init: RequestInit) => {
		assert.equal(url, "/api/tts");
		assert.equal(init.method, "POST");
		const body = JSON.parse(init.body as string) as { text: string; voiceId?: string; modelId?: string };
		const text = body.text;
		return new Promise<Response>((resolve, reject) => {
			requests.push({ text, voiceId: body.voiceId, modelId: body.modelId, signal: init.signal, respond: resolve, reject });
			init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});
	}) as unknown as typeof fetch;
	const player = createReadAloudPlayer({
		fetch: fetchFake,
		createAudio: () => {
			const audio = new FakeAudio();
			audios.push(audio);
			return audio;
		},
		createObjectURL: (blob) => {
			const url = `blob:${++urlCount}`;
			blobs.set(url, blob);
			return url;
		},
		revokeObjectURL: (url) => revoked.push(url),
		speech,
	});
	const snapshots: ReadAloudSnapshot[] = [];
	player.subscribe(() => snapshots.push(player.getSnapshot()));
	return {
		player,
		requests,
		revoked,
		snapshots,
		audio: () => audios[0]!,
		audioCount: () => audios.length,
		blobs,
		/** Answer request `i` with audio bytes labelled `label`. */
		ok: (i: number, label = `audio${i}`) =>
			requests[i]!.respond(new Response(label, { status: 200, headers: { "content-type": "audio/mpeg" } })),
	};
}

/** Let promise continuations run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("request options", () => {
	it("sends the voice and model with every chunk; absent options are not sent", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const player = createReadAloudPlayer({
			fetch: (async (_url: string, init: RequestInit) => {
				bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
				return new Response("a", { status: 200 });
			}) as unknown as typeof fetch,
			createAudio: () => ({ src: "", onended: null, onerror: null, play: async () => {}, pause() {} }),
			createObjectURL: () => "blob:x",
			revokeObjectURL: () => {},
		});
		void player.play("m1", ["one"], { voiceId: "VoiceId123", modelId: "eleven_v3" });
		await settle();
		player.stop();
		void player.play("m2", ["two"]);
		await settle();
		player.stop();
		assert.deepEqual(bodies, [
			{ text: "one", voiceId: "VoiceId123", modelId: "eleven_v3" },
			{ text: "two" },
		]);
	});
});

describe("playing a source", () => {
	it("requests the first chunk, then plays it and reports the source as playing", async () => {
		const h = harness();
		const done = h.player.play("m1", ["First chunk."]);
		await settle();
		assert.equal(h.player.getSnapshot().sourceId, "m1");
		assert.deepEqual(h.requests.map((r) => r.text), ["First chunk."]);
		assert.equal(h.audioCount(), 0, "no audio element until there is something to play");
		h.ok(0);
		await settle();
		assert.equal(h.audio().played.length, 1);
		h.audio().end();
		await done;
		assert.equal(h.player.getSnapshot().sourceId, null);
	});

	it("plays chunks in order, requesting chunk n+1 while chunk n plays", async () => {
		const h = harness();
		const done = h.player.play("m1", ["one", "two", "three"]);
		await settle();
		// Only the first chunk is asked for until it is ready to play.
		assert.deepEqual(h.requests.map((r) => r.text), ["one"]);
		h.ok(0, "A");
		await settle();
		// Chunk one is playing; chunk two is already on its way, chunk three is not.
		assert.deepEqual(h.requests.map((r) => r.text), ["one", "two"]);
		assert.equal(h.audio().played.length, 1);
		h.ok(1, "B");
		await settle();
		assert.equal(h.audio().played.length, 1, "chunk two waits for chunk one to end");
		h.audio().end();
		await settle();
		assert.equal(h.audio().played.length, 2, "chunk two starts the moment chunk one ends");
		assert.deepEqual(h.requests.map((r) => r.text), ["one", "two", "three"]);
		h.ok(2, "C");
		h.audio().end();
		await settle();
		assert.equal(h.audio().played.length, 3);
		h.audio().end();
		await done;
		// The audio actually played is the bytes of each chunk, in order.
		const bytes = await Promise.all(h.audio().played.map((url) => h.blobs.get(url)!.text()));
		assert.deepEqual(bytes, ["A", "B", "C"]);
		assert.equal(h.player.getSnapshot().sourceId, null);
	});

	it("waits (still 'playing') when the next chunk is not ready at a chunk end", async () => {
		const h = harness();
		const done = h.player.play("m1", ["one", "two"]);
		await settle();
		h.ok(0);
		await settle();
		h.audio().end();
		await settle();
		assert.equal(h.audio().played.length, 1);
		assert.equal(h.player.getSnapshot().sourceId, "m1");
		h.ok(1);
		await settle();
		assert.equal(h.audio().played.length, 2);
		h.audio().end();
		await done;
	});

	it("uses one audio element for everything", async () => {
		const h = harness();
		const first = h.player.play("a", ["x"]);
		await settle();
		h.ok(0);
		await settle();
		h.audio().end();
		await first;
		const second = h.player.play("b", ["y"]);
		await settle();
		h.ok(1);
		await settle();
		h.audio().end();
		await second;
		assert.equal(h.audioCount(), 1);
	});

	it("revokes every blob URL it created", async () => {
		const h = harness();
		const done = h.player.play("m1", ["one", "two"]);
		await settle();
		h.ok(0);
		await settle();
		h.ok(1);
		h.audio().end();
		await settle();
		h.audio().end();
		await done;
		assert.deepEqual([...h.revoked].sort(), ["blob:1", "blob:2"]);
	});

	it("playing nothing does nothing", async () => {
		const h = harness();
		await h.player.play("m1", []);
		assert.equal(h.player.getSnapshot().sourceId, null);
		assert.equal(h.requests.length, 0);
	});

	it("notifies subscribers on start and finish, and the snapshot only changes when state does", async () => {
		const h = harness();
		const before = h.player.getSnapshot();
		assert.equal(h.player.getSnapshot(), before, "stable between changes");
		const done = h.player.play("m1", ["x"]);
		await settle();
		h.ok(0);
		await settle();
		h.audio().end();
		await done;
		assert.deepEqual(h.snapshots.map((s) => s.sourceId), ["m1", null]);
	});
});

describe("how play() ends (auto-read sequencing, slice 11)", () => {
	it("resolves true when the source played to its end", async () => {
		const h = harness();
		const done = h.player.play("m1", ["x"]);
		await settle();
		h.ok(0);
		await settle();
		h.audio().end();
		assert.equal(await done, true);
	});

	it("resolves false when it was stopped, superseded by another source, or failed", async () => {
		const stopped = harness();
		const a = stopped.player.play("m1", ["x"]);
		await settle();
		stopped.player.stop();
		assert.equal(await a, false);

		const superseded = harness();
		const b = superseded.player.play("m1", ["x"]);
		await settle();
		void superseded.player.play("m2", ["y"]);
		assert.equal(await b, false);

		const failed = harness();
		const c = failed.player.play("m1", ["x"]);
		await settle();
		failed.requests[0]!.respond(Response.json({ message: "boom" }, { status: 502 }));
		assert.equal(await c, false);
	});
});

describe("one source at a time", () => {
	it("starting another source stops the first: audio paused, its pending chunks never played", async () => {
		const h = harness();
		void h.player.play("a", ["a1", "a2"]);
		await settle();
		h.ok(0);
		await settle();
		assert.equal(h.audio().played.length, 1);
		void h.player.play("b", ["b1"]);
		await settle();
		assert.equal(h.player.getSnapshot().sourceId, "b");
		assert(h.audio().paused >= 1, "the first source's audio was paused");
		// The first source's prefetch (a2) was aborted and, even if it answers late, never plays.
		assert.equal(h.requests[1]!.signal!.aborted, true);
		h.ok(1, "late");
		h.ok(2, "B1");
		await settle();
		assert.equal(h.audio().played.length, 2, "only b1 started after a1");
		const last = await h.blobs.get(h.audio().played[1]!)!.text();
		assert.equal(last, "B1");
	});
});

describe("stop", () => {
	it("pauses, clears the source, aborts in-flight requests and revokes the playing URL", async () => {
		const h = harness();
		void h.player.play("a", ["a1", "a2"]);
		await settle();
		h.ok(0);
		await settle();
		h.player.stop();
		assert.equal(h.player.getSnapshot().sourceId, null);
		assert(h.audio().paused >= 1);
		assert.equal(h.requests[1]!.signal!.aborted, true);
		assert.deepEqual(h.revoked, ["blob:1"]);
		h.ok(1);
		await settle();
		assert.equal(h.audio().played.length, 1, "nothing plays after stop");
	});

	it("stop before any audio is ready cancels the request", async () => {
		const h = harness();
		void h.player.play("a", ["a1"]);
		await settle();
		h.player.stop();
		assert.equal(h.requests[0]!.signal!.aborted, true);
		assert.equal(h.player.getSnapshot().sourceId, null);
		assert.equal(h.player.getSnapshot().error, null, "an abort is not an error");
	});

	it("stop when idle is a no-op", () => {
		const h = harness();
		h.player.stop();
		assert.equal(h.snapshots.length, 0);
	});
});

describe("errors", () => {
	const fail = async (respond: (h: ReturnType<typeof harness>) => void) => {
		const h = harness();
		void h.player.play("m1", ["one", "two"]);
		await settle();
		respond(h);
		await settle();
		return h;
	};

	it("no key: a 503 with the keyless marker is the keyless error, on that source", async () => {
		const h = await fail((x) =>
			x.requests[0]!.respond(Response.json({ message: "No ELEVENLABS_API_KEY — add it", keyless: "ELEVENLABS_API_KEY" }, { status: 503 })),
		);
		assert.deepEqual(h.player.getSnapshot(), {
			sourceId: null,
			error: { sourceId: "m1", kind: "keyless", message: READ_ALOUD_KEYLESS },
		});
		assert.equal(READ_ALOUD_KEYLESS, "Read aloud needs an ElevenLabs key");
	});

	it("an upstream error carries the server's short message", async () => {
		const h = await fail((x) =>
			x.requests[0]!.respond(Response.json({ message: "ElevenLabs error (401): quota", upstreamStatus: 401 }, { status: 502 })),
		);
		assert.deepEqual(h.player.getSnapshot().error, { sourceId: "m1", kind: "upstream", message: "ElevenLabs error (401): quota" });
		assert.equal(h.player.getSnapshot().sourceId, null);
	});

	it("an unreadable error body still yields an upstream error with the status", async () => {
		const h = await fail((x) => x.requests[0]!.respond(new Response("<html>", { status: 500 })));
		assert.equal(h.player.getSnapshot().error!.kind, "upstream");
		assert(h.player.getSnapshot().error!.message.includes("500"));
	});

	it("a network failure is an upstream error", async () => {
		const h = await fail((x) => x.requests[0]!.reject(new TypeError("Failed to fetch")));
		assert.equal(h.player.getSnapshot().error!.kind, "upstream");
	});

	it("a later chunk failing stops playback with the error", async () => {
		const h = harness();
		void h.player.play("m1", ["one", "two"]);
		await settle();
		h.ok(0);
		await settle();
		h.requests[1]!.respond(Response.json({ message: "ElevenLabs error (429)" }, { status: 502 }));
		await settle();
		h.audio().end();
		await settle();
		assert.equal(h.player.getSnapshot().sourceId, null);
		assert.equal(h.player.getSnapshot().error!.message, "ElevenLabs error (429)");
		assert.equal(h.audio().played.length, 1);
	});

	it("an audio element error is an upstream error", async () => {
		const h = harness();
		void h.player.play("m1", ["one"]);
		await settle();
		h.ok(0);
		await settle();
		h.audio().fail();
		await settle();
		assert.equal(h.player.getSnapshot().error!.kind, "upstream");
		assert.equal(h.player.getSnapshot().sourceId, null);
		assert.deepEqual(h.revoked, ["blob:1"]);
	});

	it("a refused play() (autoplay policy) is an upstream error, not a hang", async () => {
		const h = harness();
		void h.player.play("m1", ["one"]);
		await settle();
		h.ok(0);
		await settle();
		// The element is created by now; make the NEXT play fail by replaying.
		h.audio().playRejects = true;
		void h.player.play("m2", ["two"]);
		await settle();
		h.ok(1);
		await settle();
		assert.equal(h.player.getSnapshot().error!.kind, "upstream");
		assert.equal(h.player.getSnapshot().error!.sourceId, "m2");
	});

	it("starting a new source clears the previous error; clearError clears it too", async () => {
		const h = await fail((x) => x.requests[0]!.respond(new Response("no", { status: 500 })));
		assert(h.player.getSnapshot().error);
		void h.player.play("m2", ["x"]);
		await settle();
		assert.equal(h.player.getSnapshot().error, null);
		h.player.stop();
		const again = await fail((x) => x.requests[0]!.respond(new Response("no", { status: 500 })));
		again.player.clearError();
		assert.equal(again.player.getSnapshot().error, null);
	});
});

describe("the in-memory audio cache", () => {
	/** Play one single-chunk source to its end. */
	const playThrough = async (h: ReturnType<typeof harness>, chunks: string[], answer?: number) => {
		const done = h.player.play("m1", chunks);
		await settle();
		if (answer !== undefined) h.ok(answer);
		await settle();
		h.audio().end();
		await done;
	};

	it("a second play of the same message makes no new request", async () => {
		const h = harness();
		await playThrough(h, ["Hello there."], 0);
		assert.equal(h.requests.length, 1);
		const again = h.player.play("m1", ["Hello there."]);
		await settle();
		assert.equal(h.requests.length, 1, "served from memory");
		assert.equal(h.audio().played.length, 2, "and it plays");
		h.audio().end();
		await again;
	});

	it("a different voice or model makes a new request, and each is cached on its own", async () => {
		let options: { voiceId?: string; modelId?: string } = {};
		const h = harness(() => options);
		await playThrough(h, ["Hi."], 0);
		options = { voiceId: "v1" };
		await playThrough(h, ["Hi."], 1);
		options = { voiceId: "v1", modelId: "m1" };
		await playThrough(h, ["Hi."], 2);
		assert.deepEqual(
			h.requests.map((r) => [r.voiceId, r.modelId]),
			[
				[undefined, undefined],
				["v1", undefined],
				["v1", "m1"],
			],
		);
		options = { voiceId: "v1" };
		const again = h.player.play("m1", ["Hi."]);
		await settle();
		assert.equal(h.requests.length, 3);
		h.audio().end();
		await again;
	});

	it("an aborted or failed load is never cached", async () => {
		const h = harness();
		const stopped = h.player.play("m1", ["Hi."]);
		await settle();
		h.player.stop();
		await stopped;
		const failed = h.player.play("m1", ["Hi."]);
		await settle();
		h.requests[1]!.respond(new Response("no", { status: 500 }));
		await failed;
		assert.equal(h.player.getSnapshot().error?.kind, "upstream");
		await playThrough(h, ["Hi."], 2);
		assert.equal(h.requests.length, 3, "each earlier attempt asked again");
		await playThrough(h, ["Hi."]);
		assert.equal(h.requests.length, 3, "the success is cached");
	});
});

describe("the audio source seam", () => {
	it("loadChunk replaces the network fetch (where a cache slots in)", async () => {
		const loads: string[] = [];
		const audios: FakeAudio[] = [];
		const player = createReadAloudPlayer({
			loadChunk: async (text) => {
				loads.push(text);
				return new Blob([text], { type: "audio/mpeg" });
			},
			createAudio: () => {
				const audio = new FakeAudio();
				audios.push(audio);
				return audio;
			},
			createObjectURL: () => "blob:x",
			revokeObjectURL: () => {},
		});
		const done = player.play("m1", ["a", "b"]);
		await settle();
		audios[0]!.end();
		await settle();
		audios[0]!.end();
		await done;
		assert.deepEqual(loads, ["a", "b"]);
		assert.equal(audios[0]!.played.length, 2);
	});
});

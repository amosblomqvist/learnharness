/**
 * The dictation chunker: where it cuts, that it never exceeds its maximum, what it
 * drops as not worth sending, and what it does when voice activity detection fails.
 * Cut planning runs on synthetic Silero probabilities (ported from pi-voice's
 * chunking tests, MIT, with the 12-18 s window in place of its 5-40 s one); the
 * chunker runs on synthetic PCM scored by a loudness stand-in for Silero
 * (tests/helpers/dictation-vad.ts). The real model is in dictation-vad-runtime.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createChunker, cutCandidates, hasSpeech, joinTranscripts, planCut, speechSegments,
	type PcmChunk, type VadScore,
} from "../src/core/dictation-chunks.ts";
import {
	GROQ_CHUNK_MAX_SECONDS, GROQ_CHUNK_MIN_SECONDS, GROQ_CHUNK_TARGET_SECONDS, GROQ_MIN_PCM_BYTES,
} from "../src/core/dictation.ts";
import { energyVad } from "./helpers/dictation-vad.ts";

const RATE = 16000;
const FRAME = 512; // Silero's frame: 32 ms
const WORKLET_FRAME = 2048; // the worklet's frame, 128 ms
const s = (seconds: number) => Math.round(seconds * RATE);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Frame probabilities: speech everywhere except the given pauses, in seconds. */
function probsWithPauses(seconds: number, pauses: Array<[start: number, end: number]>): number[] {
	return Array.from({ length: Math.ceil(s(seconds) / FRAME) }, (_, i) => {
		const at = (i * FRAME) / RATE;
		return pauses.some(([start, end]) => at >= start && at < end) ? 0 : 1;
	});
}

/** Where the first cut of `seconds` of audio with these pauses falls, in seconds. */
function cutAt(seconds: number, pauses: Array<[number, number]>): number {
	return planCut(probsWithPauses(seconds, pauses), s(seconds), RATE) / RATE;
}

describe("speech segments follow Silero", () => {
	it("drops short blips, bridges short dips and pads the edges", () => {
		const probs = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
		const segments = speechSegments(probs, probs.length * FRAME, RATE);
		// Frames 2-19 are one segment (a 2-frame dip is under 100 ms); the lone frame 25 is under 250 ms.
		assert.deepEqual(segments, [{ start: 2 * FRAME - 480, end: 20 * FRAME + 480 }]);
	});

	it("a speech run still open at the end runs to the end of the audio", () => {
		const probs = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
		assert.deepEqual(speechSegments(probs, probs.length * FRAME, RATE), [{ start: 2 * FRAME - 480, end: probs.length * FRAME }]);
	});

	it("silence has no segments, and neither does a run under 250 ms", () => {
		assert.deepEqual(speechSegments(new Array(100).fill(0.01), 100 * FRAME, RATE), []);
		assert.deepEqual(speechSegments([0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], 13 * FRAME, RATE), [], "7 frames is 224 ms");
	});

	it("puts one cut candidate in the middle of each pause, lead-in and tail included", () => {
		const segments = [{ start: s(2), end: s(5) }, { start: s(6), end: s(8) }];
		assert.deepEqual(cutCandidates(segments, s(10), RATE).map(({ cut, gapSeconds }) => [cut / RATE, gapSeconds]), [[1, 2], [5.5, 1], [9, 2]]);
	});
});

describe("planning a cut", () => {
	it("cuts in the middle of a pause inside the 12-18 s window, not at 15 s", () => {
		const cut = cutAt(18, [[16.2, 16.6]]);
		assert.ok(cut > 16.2 && cut < 16.6, `cut ${cut} s is inside the pause`);
	});

	it("prefers the longest pause: a long pause far from 15 s beats a short one on it", () => {
		// A 0.3 s pause at 14.85 s and a 1 s pause at 16 s.
		const cut = cutAt(18, [[14.85, 15.15], [16, 17]]);
		assert.ok(cut > 16 && cut < 17, `cut ${cut} s is in the long pause`);
	});

	it("among pauses of a second or more, the one nearest 15 s wins", () => {
		const cut = cutAt(18, [[12.4, 13.7], [14.4, 15.7], [16.7, 18]]);
		assert.ok(cut > 14.4 && cut < 15.7, `cut ${cut} s`);
	});

	it("among equally short pauses, the one nearest 15 s wins", () => {
		const cut = cutAt(18, [[12.5, 12.8], [14.6, 14.9], [17.4, 17.7]]);
		assert.ok(cut > 14.6 && cut < 14.9, `cut ${cut} s`);
	});

	it("ignores a pause before the window, and cuts hard at the maximum without another", () => {
		assert.equal(cutAt(18, [[8, 8.5]]), GROQ_CHUNK_MAX_SECONDS);
	});

	it("cuts hard at the maximum when the speaker never pauses", () => {
		assert.equal(cutAt(18, []), GROQ_CHUNK_MAX_SECONDS);
	});

	it("cuts a window that is all silence at its earliest allowed point", () => {
		assert.equal(cutAt(18, [[0, 18]]), GROQ_CHUNK_MIN_SECONDS);
	});

	it("uses the part of a pause that is inside the window when its middle is not", () => {
		// A 10-13.2 s pause has its middle at 11.6 s, before the window: the cut is the window's start.
		assert.equal(cutAt(18, [[10, 13.2]]), GROQ_CHUNK_MIN_SECONDS);
		// One from 17.3 s to the end has its middle after 17.6 s; still in the window.
		const late = cutAt(18, [[17.3, 18]]);
		assert.ok(late > 17.3 && late <= GROQ_CHUNK_MAX_SECONDS, `cut ${late} s`);
	});

	it("never cuts outside the window", () => {
		for (const pauses of [[[0, 5]], [[11.5, 12.2]], [[17.9, 18]], [[13, 14], [16, 16.5]], []] as Array<Array<[number, number]>>) {
			const cut = cutAt(18, pauses);
			assert.ok(cut >= GROQ_CHUNK_MIN_SECONDS && cut <= GROQ_CHUNK_MAX_SECONDS, `${JSON.stringify(pauses)}: ${cut} s`);
		}
	});

	it("targets the middle of the window", () => {
		assert.ok(GROQ_CHUNK_MIN_SECONDS < GROQ_CHUNK_TARGET_SECONDS && GROQ_CHUNK_TARGET_SECONDS < GROQ_CHUNK_MAX_SECONDS);
	});
});

describe("is there speech", () => {
	it("needs 60 ms of frames above 0.3 in a row: a short word counts, a click does not", () => {
		const frames = (voiced: number[]) => [...new Array(20).fill(0.01), ...voiced, ...new Array(20).fill(0.01)];
		assert.equal(hasSpeech(frames([0.9]), RATE), false, "one 32 ms frame");
		assert.equal(hasSpeech(frames([0.9, 0.05, 0.9]), RATE), false, "two separate frames");
		assert.equal(hasSpeech(frames([0.9, 0.4]), RATE), true, "two frames in a row");
		assert.equal(hasSpeech(frames([0.31, 0.31]), RATE), true, "just over the pi-voice threshold");
		assert.equal(hasSpeech(frames([0.29, 0.29, 0.29]), RATE), false, "just under it");
		assert.equal(hasSpeech([], RATE), false);
	});
});

describe("joining transcripts", () => {
	it("puts spaces only between spaced scripts", () => {
		assert.equal(joinTranscripts([" Hello there. ", "", "General Kenobi."]), "Hello there. General Kenobi.");
		assert.equal(joinTranscripts(["今天天气很好。", "我们去公园吧。"]), "今天天气很好。我们去公园吧。");
		assert.equal(joinTranscripts(["I said", "你好"]), "I said你好");
		assert.equal(joinTranscripts(["안녕하세요.", "반갑습니다."]), "안녕하세요. 반갑습니다.");
		// CJK Extension B is a surrogate pair.
		assert.equal(joinTranscripts(["你好𠀀", "我们"]), "你好𠀀我们");
		assert.equal(joinTranscripts([]), "");
	});
});

// ── the chunker, on synthetic PCM ────────────────────────────────────────────

/** Loud audio standing in for speech: a sine, so every frame has energy. */
function loud(seconds: number, amplitude = 8000): Int16Array {
	const out = new Int16Array(s(seconds));
	for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));
	return out;
}
const quiet = (seconds: number) => new Int16Array(s(seconds));
function join(...parts: Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) { out.set(part, at); at += part.length; }
	return out;
}

/** Speech with a pause at each given (start, length) second range. */
function speech(totalSeconds: number, pauses: [number, number][] = []): Int16Array {
	const audio = loud(totalSeconds);
	for (const [start, length] of pauses) audio.fill(0, s(start), s(start + length));
	return audio;
}

/** A scorer that records the size of every clip it was asked to score. */
function spy(score: VadScore = energyVad) {
	const calls: number[] = [];
	const scorer: VadScore = (pcm) => { calls.push(pcm.length); return score(pcm); };
	return { scorer, calls };
}

/** Feed audio the way the worklet does, in 2048-sample frames, then finish. */
async function chunkAll(audio: Int16Array, score: VadScore = energyVad): Promise<PcmChunk[]> {
	const chunks: PcmChunk[] = [];
	const chunker = createChunker({ sampleRate: RATE, score, onChunk: (chunk) => chunks.push(chunk) });
	for (let at = 0; at < audio.length; at += WORKLET_FRAME) chunker.push(audio.slice(at, at + WORKLET_FRAME));
	const last = await chunker.finish();
	if (last) chunks.push(last);
	return chunks;
}

const endOf = (chunk: PcmChunk) => chunk.pcm.length / RATE;

describe("where the chunker cuts", () => {
	it("cuts in the middle of a pause inside the 12-18 s window, not at 15 s", async () => {
		const chunks = await chunkAll(speech(40, [[16.2, 0.4]]));
		assert.ok(endOf(chunks[0]!) > 16.2 && endOf(chunks[0]!) < 16.6, `first cut ${endOf(chunks[0]!)} s is inside the pause`);
	});

	it("a faint stretch is still speech to Silero: the real gap wins", async () => {
		const audio = speech(40, [[17.0, 0.3]]);
		const dip = audio.subarray(s(13), s(13.3));
		for (let i = 0; i < dip.length; i++) dip[i] = Math.round(1000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
		const first = (await chunkAll(audio))[0]!;
		assert.ok(endOf(first) > 17.0 && endOf(first) < 17.3, `cut ${endOf(first)} s is in the real gap`);
	});

	it("among pauses about equally short, prefers the one nearest 15 s", async () => {
		const chunks = await chunkAll(speech(40, [[12.5, 0.3], [14.6, 0.3], [17.4, 0.3]]));
		assert.ok(endOf(chunks[0]!) > 14.6 && endOf(chunks[0]!) < 14.9, `cut ${endOf(chunks[0]!)} s`);
	});

	it("ignores pauses outside the window", async () => {
		const chunks = await chunkAll(speech(40, [[8, 0.5], [21, 0.5]]));
		assert.ok(endOf(chunks[0]!) >= GROQ_CHUNK_MIN_SECONDS && endOf(chunks[0]!) <= GROQ_CHUNK_MAX_SECONDS);
		assert.ok(!(endOf(chunks[0]!) > 8 && endOf(chunks[0]!) < 8.5));
	});

	it("never lets a chunk exceed the maximum, even when there is no pause at all", async () => {
		const chunks = await chunkAll(loud(100));
		assert.ok(chunks.length >= 6);
		for (const chunk of chunks.slice(0, -1)) {
			assert.ok(chunk.seconds >= GROQ_CHUNK_MIN_SECONDS && chunk.seconds <= GROQ_CHUNK_MAX_SECONDS, `${chunk.seconds} s`);
		}
		assert.ok(chunks.at(-1)!.seconds <= GROQ_CHUNK_MAX_SECONDS);
		assert.equal(chunks[0]!.seconds, GROQ_CHUNK_MAX_SECONDS, "with no pause the cut is hard, at the maximum");
	});

	it("loses and repeats no audio: the chunks joined are the recording", async () => {
		const audio = speech(63.37, [[15.1, 0.3], [29.9, 0.4], [44, 0.3]]);
		const chunks = await chunkAll(audio);
		assert.deepEqual(join(...chunks.map((c) => c.pcm)), audio);
	});

	it("waits until 18 s are buffered before cutting, so nothing is emitted early", async () => {
		const chunks: PcmChunk[] = [];
		const chunker = createChunker({ sampleRate: RATE, score: energyVad, onChunk: (chunk) => chunks.push(chunk) });
		const audio = speech(40, [[16, 0.4]]);
		let emittedAt: number | undefined;
		for (let at = 0; at < audio.length && emittedAt === undefined; at += WORKLET_FRAME) {
			chunker.push(audio.slice(at, at + WORKLET_FRAME));
			await tick();
			if (chunks.length) emittedAt = (at + WORKLET_FRAME) / RATE;
		}
		assert.ok(emittedAt! >= GROQ_CHUNK_MAX_SECONDS && emittedAt! < GROQ_CHUNK_MAX_SECONDS + 0.2, `${emittedAt} s`);
	});

	it("handles a burst bigger than two chunks in one push, in order", async () => {
		const chunks: PcmChunk[] = [];
		const chunker = createChunker({ sampleRate: RATE, score: energyVad, onChunk: (chunk) => chunks.push(chunk) });
		chunker.push(loud(40));
		const last = await chunker.finish();
		assert.equal(chunks.length, 2);
		assert.ok(last!.seconds < GROQ_CHUNK_MAX_SECONDS);
		assert.equal(chunks[0]!.seconds + chunks[1]!.seconds + last!.seconds, 40);
	});
});

describe("how it scores", () => {
	it("scores the 18 s window in one request per chunk, never more than 18 s", async () => {
		const { scorer, calls } = spy();
		const chunks = await chunkAll(speech(70, [[15, 0.4], [31, 0.4], [48, 0.4]]), scorer);
		const full = calls.filter((n) => n === s(GROQ_CHUNK_MAX_SECONDS));
		assert.equal(full.length, chunks.length - 1, "one window request for each chunk before the last");
		assert.equal(calls.length, chunks.length, "plus one for the last chunk");
		assert.ok(calls.every((n) => n <= s(GROQ_CHUNK_MAX_SECONDS)));
	});

	it("keeps audio that arrives while a request is out, and cuts it afterwards", async () => {
		let release!: (probs: number[]) => void;
		let asked = 0;
		// Only the cut's request is slow; the last chunk's answers at once.
		const slow: VadScore = (pcm) => asked++ > 0 ? energyVad(pcm) : new Promise((resolve) => { release = resolve; });
		const chunks: PcmChunk[] = [];
		const audio = loud(25);
		const chunker = createChunker({ sampleRate: RATE, score: slow, onChunk: (chunk) => chunks.push(chunk) });
		chunker.push(audio.slice(0, s(18)));
		await tick();
		chunker.push(audio.slice(s(18)));
		assert.equal(chunker.samples, s(25));
		release(await energyVad(audio.slice(0, s(18))));
		const last = await chunker.finish();
		assert.equal(chunks.length, 1);
		assert.deepEqual(join(chunks[0]!.pcm, last!.pcm), audio, "nothing lost, nothing repeated");
	});

	it("finish waits for a cut in progress, so the last chunk comes after the ones before", async () => {
		let release!: (probs: number[]) => void;
		let asked = 0;
		const gate: VadScore = (pcm) => {
			if (asked++ > 0) return energyVad(pcm);
			return new Promise((resolve) => { release = resolve; });
		};
		const order: string[] = [];
		const chunker = createChunker({ sampleRate: RATE, score: gate, onChunk: () => order.push("cut") });
		chunker.push(loud(20));
		await tick();
		const finishing = chunker.finish().then((chunk) => { order.push(chunk ? "last" : "none"); });
		await tick();
		assert.deepEqual(order, [], "finish is still waiting for the cut");
		release(await energyVad(loud(18)));
		await finishing;
		assert.deepEqual(order, ["cut", "last"]);
	});

	it("ignores audio pushed after finish", async () => {
		const chunks: PcmChunk[] = [];
		const chunker = createChunker({ sampleRate: RATE, score: energyVad, onChunk: (chunk) => chunks.push(chunk) });
		chunker.push(loud(2));
		await chunker.finish();
		chunker.push(loud(30));
		await tick();
		assert.equal(chunks.length, 0);
		assert.equal(chunker.samples, s(2));
	});
});

describe("what it will not send", () => {
	it("drops a recording of only silence", async () => {
		assert.equal((await chunkAll(quiet(40))).length, 0);
	});

	it("drops the silent chunks of a long wait but keeps the one with the words", async () => {
		const audio = join(quiet(30), loud(5));
		const chunks = await chunkAll(audio);
		assert.equal(chunks.length, 1, "two silent windows went, the tail stayed");
		assert.equal(chunks[0]!.seconds, 11);
		assert.deepEqual(chunks[0]!.pcm, audio.slice(s(24)));
	});

	it("is not fooled into dropping a long chunk with only a little speech in it", async () => {
		const chunks = await chunkAll(join(quiet(8), loud(1.2), quiet(9)));
		assert.equal(chunks.length, 1, "the chunk with the speech stays; the silent rest goes");
	});

	it("keeps a short word and drops a lone click, as Silero hears them", async () => {
		const answer = (voiced: number) => async (pcm: Int16Array) =>
			Array.from({ length: Math.ceil(pcm.length / FRAME) }, (_, i) => (i >= 40 && i < 40 + voiced ? 0.9 : 0.01));
		assert.equal((await chunkAll(quiet(10), answer(1))).length, 0, "one 32 ms frame");
		assert.equal((await chunkAll(quiet(10), answer(2))).length, 1, "64 ms");
	});

	it("drops a final chunk shorter than 0.3 s without asking Silero, and sends one a little longer", async () => {
		const shortest = GROQ_MIN_PCM_BYTES / 2;
		assert.ok(Math.abs(shortest / RATE - 0.3) < 0.001);
		const short = spy();
		assert.deepEqual(await chunkAll(loud(0.28), short.scorer), []);
		assert.equal(short.calls.length, 0, "too short to be worth a request");
		assert.equal((await chunkAll(loud(0.4))).length, 1);
	});

	it("drops a very short tail after a full chunk", async () => {
		// The only pause in the window ends the chunk 0.2 s before the stop.
		const chunks = await chunkAll(speech(18.1, [[17.8, 0.2]]));
		assert.equal(chunks.length, 1, "the 0.2 s tail is not a chunk");
		assert.ok(chunks[0]!.seconds > 17.8 && chunks[0]!.seconds < 18, `cut at ${chunks[0]!.seconds} s`);
	});

	it("finishing with nothing buffered gives no chunk, and finishing twice gives one", async () => {
		const empty = createChunker({ sampleRate: RATE, score: energyVad, onChunk: () => {} });
		assert.equal(await empty.finish(), null);
		const chunker = createChunker({ sampleRate: RATE, score: energyVad, onChunk: () => {} });
		chunker.push(loud(2));
		assert.ok(await chunker.finish());
		assert.equal(await chunker.finish(), null, "the audio is handed out once");
	});
});

describe("when voice activity detection fails", () => {
	const failing: VadScore = async () => { throw new Error("Voice activity detection failed (503)"); };

	it("keeps the chunk and cuts it at the maximum, pause or not, silent or not", async () => {
		const { scorer, calls } = spy(failing);
		const audio = join(speech(18, [[16, 0.4]]), quiet(20));
		const chunks = await chunkAll(audio, scorer);
		assert.equal(chunks[0]!.seconds, GROQ_CHUNK_MAX_SECONDS, "no pause is known, so the cut is hard");
		assert.ok(chunks.length >= 2, "the silent part is kept too: nothing can be judged silent");
		assert.deepEqual(join(...chunks.map((c) => c.pcm)), audio, "no audio lost");
		assert.ok(calls.length >= 2, "each chunk asks again");
	});

	it("keeps the last chunk, silent or not", async () => {
		const chunks = await chunkAll(quiet(5), failing);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0]!.seconds, 5);
	});

	it("treats an answer of the wrong length as a failure", async () => {
		const chunks = await chunkAll(join(quiet(20), loud(3)), async () => [0.9, 0.9, 0.9]);
		assert.equal(chunks[0]!.seconds, GROQ_CHUNK_MAX_SECONDS);
		assert.equal(chunks.length, 2);
	});

	it("recovers on the next chunk when the server comes back", async () => {
		let asked = 0;
		const flaky: VadScore = (pcm) => (asked++ === 0 ? failing(pcm) : energyVad(pcm));
		const audio = speech(40, [[30, 0.4]]);
		const chunks = await chunkAll(audio, flaky);
		assert.equal(chunks[0]!.seconds, GROQ_CHUNK_MAX_SECONDS, "the first chunk was cut blind");
		assert.ok(chunks[1]!.seconds > 12 && chunks[1]!.seconds <= GROQ_CHUNK_MAX_SECONDS);
		assert.deepEqual(join(...chunks.map((c) => c.pcm)), audio);
	});
});
